// onboarding-service.ts — starting onboarding and reporting whether it has started (#2360).
//
// Start is one path for every caller (the console's Start button, and the coordinator's
// onboarding-start tool): it holds triage, enables the capabilities onboarding needs, creates
// the onboarding task tree from the playbook, rotates the web thread and reaches the principal.
// No message is sent from here: on Signal, SMS and Slack the parent task is woken with a
// "Send the greeting" note and the coordinator composes it; on the app route the greeting
// waits for the invitation to be redeemed. A principal who asks for onboarding is already
// talking to Curia, so their start does not reach out (the greeting counts as sent), and it
// rotates the web thread only when they asked from another channel.
//
// Idempotency: the whole start runs under a transaction-scoped advisory lock, so two presses
// (double click, two tabs) serialize and the second sees the first's committed task and
// answers already_started. Task rows are written through TaskRepo on other pool connections
// (autocommit), so a failure part-way, or a failed COMMIT, undoes what this start did rather than
// leaving an open onboarding task that would block a retry.

import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Logger } from '../logger.js';
import type { TaskRepo } from '../db/task-repo.js';
import type { TaskRow } from '../db/queries/tasks.js';
import type { WorkingDocsRepo } from '../db/working-docs-repo.js';
import type { RegistryService } from '../registry/registry-service.js';
import type { RegistryKind } from '../registry/types.js';
import type { SchedulerService } from '../scheduler/scheduler-service.js';
import type { ConfigStore } from '../memory/config-store.js';
import type { MintedInvitation } from '../channels/http/pairing-invitations.js';
import {
  mintInvitation as mintPairingInvitation,
  stopInvitation as stopPairingInvitation,
} from '../channels/http/pairing-invitations.js';
import { choosePairOrigin } from '../channels/http/pairing.js';
import { noteWebThreadRotated, rotateWebThreadRow } from '../channels/http/web-thread.js';
import { replaceActiveSkillsBlock } from '../db/active-skills-progress.js';
import { makeSystemOriginator } from '../contacts/principal.js';
import { readSetupState, type MessagingRoute, type SetupFor } from '../setup/setup-settings.js';
import { readPlaybook, type PlaybookSession } from './playbook.js';
import {
  findOpenOnboardingTask,
  readOnboardingState,
  readOnboardingStateRaw,
  updateOnboardingState,
  writeOnboardingState,
  writeOnboardingStateRaw,
  ONBOARDING_TASK_TAG,
  type OnboardingState,
  type OnboardingStateLock,
} from './state.js';
import { isTriageHeld, releaseTriageHold, setTriageHold, writeTriageHold } from './triage-hold.js';
import { RECURRING_SESSION, topicSubtasks } from './subtasks.js';
import {
  FIRST_CONVERSATION_SESSION,
  ONBOARDING_CREATED_BY,
  PRINCIPAL_RESTART_EXIT_DELAY_SECONDS,
  RESTART_WAKE_DELAY_SECONDS,
} from './constants.js';

/** Signals that the install is already in use, so starting onboarding needs confirming. */
export const WORKING_PRINCIPAL_SIGNALS = {
  emailTriageEnabled: 'email_triage_enabled',
  priorPrincipalTasks: 'prior_principal_tasks',
} as const;

/** The playbook session whose topics become the onboarding task's subtasks. */
const ONBOARDING_SKILL = 'onboarding';
const EMAIL_TRIAGE_AGENT = 'ceo-inbox';
/** What onboarding needs enabled: the Email triage agent and the skills onboarding writes through. */
const REQUIRED_ENTRIES: ReadonlyArray<{ kind: RegistryKind; name: string }> = [
  { kind: 'agent', name: EMAIL_TRIAGE_AGENT },
  { kind: 'skill', name: 'ceo-inbox' },
  { kind: 'skill', name: 'learning' },
  { kind: 'skill', name: 'tasks' },
];
const START_LOCK_KEY = 'onboarding:start';
const OPEN_SESSION_LOCK_KEY = 'onboarding:open-session';
/** Longest a start waits for a concurrent one before failing (Postgres interval). */
const START_LOCK_TIMEOUT = '10s';
/** Delay before the restart exit, so the HTTP reply flushes first (as setupRoutes does). */
const RESTART_EXIT_DELAY_MS = 500;
/** Postgres lock_not_available: the advisory lock wait hit START_LOCK_TIMEOUT. */
const LOCK_NOT_AVAILABLE = '55P03';
/** The channel id of the principal's web app conversation. */
const WEB_CHANNEL_ID = 'web';
const GREETING_NOTE = 'Send the greeting';
/** A principal start that restarts Curia wakes the parent with this, so the conversation resumes. */
export const RESTART_RESUME_NOTE =
  'Curia restarted to switch on email triage (held): continue the first conversation where it left off. ' +
  "If your last message to the principal didn't go out, apologise briefly for the pause";
/** Every onboarding task: the coordinator's, owned by Curia, created by the onboarding program. */
const TASK_BASE = {
  agentId: 'coordinator',
  owner: 'curia' as const,
  source: 'scheduler' as const,
  createdBy: ONBOARDING_CREATED_BY,
};

export type OnboardingStatus = {
  started: boolean;
  taskId: string | null;
  showDashboardAlert: boolean;
  workingPrincipalSignals: string[];
  route: MessagingRoute | null;
  setupFor: SetupFor | null;
  principalName: string | null;
  /** Email triage is held until the principal hears what to expect (Capabilities shows it). */
  triageHeld: boolean;
};

export type StartResult =
  | { ok: true; taskId: string; invitation: StartedInvitation | null; restartScheduled: boolean }
  | {
      ok: false;
      /**
       * `start_in_progress`: another start held the lock past its timeout. `no_persistent_store`:
       * the knowledge graph is off, so the run state and the triage hold would not survive a restart.
       */
      code:
        | 'already_started'
        | 'start_in_progress'
        | 'confirm_working_principal'
        | 'setup_incomplete'
        | 'no_persistent_store'
        | 'route_unreachable';
      signals?: string[];
    };

/** The phone app invitation Start minted; `id` lets a caller stop it (e.g. its audit failed). */
export type StartedInvitation = { id: string; url: string; expiresAt: string };

/**
 * `actor: 'principal'` is the principal asking in conversation: no invitation, no greeting wake,
 * and the greeting counts as sent. `channelId` is the channel of their turn: the web thread is
 * rotated (so their first app view is not the operator's Setup chat) unless it is `web`, where
 * rotating would wipe the conversation they are in. Unknown → not rotated.
 */
export type StartOptions = {
  actor: 'operator' | 'principal';
  confirmWorkingPrincipal?: boolean;
  channelId?: string;
};

/** What a start changed, so a failure (part-way, or at COMMIT) can put it back. */
type StartUndo = {
  created: string[];
  mintedId: string | null;
  /** The hold before this start, restored on undo. */
  priorHeld: boolean;
  /** This start newly enabled the Email triage agent: the hold stays on after an undo. */
  enabledTriageAgent: boolean;
  /** The raw run state before this start; null when there was none. */
  priorStateRaw: string | null;
  stateWritten: boolean;
};

type LockedStart = { result: StartResult; rotatedTo: string | null; undo: StartUndo | null };

export type OpenSessionResult =
  | { ok: true; session: PlaybookSession; createdSubtasks: number }
  | { ok: false; code: 'unknown_session'; sessionIds: string[] };

/**
 * The parent and topic tasks wait on a conversation with the principal: created `waiting` on the
 * principal's contact, so the backlog heartbeat leaves them alone (selectHeartbeatCandidates skips
 * a task waiting on a person). Their wakes come from the onboarding program and the principal's
 * replies. Empty when there is no principal contact: they are then created open.
 */
type ParkedOnPrincipal = { status: 'waiting'; waitingOnContactId: string } | Record<string, never>;

/** Tags of an onboarding topic subtask. */
function topicSubtaskTags(sessionId: string, topicId: string): string[] {
  return [ONBOARDING_TASK_TAG, `onboarding:topic:${topicId}`, `onboarding:session:${sessionId}`];
}

export interface OnboardingServiceDeps {
  pool: Pool;
  taskRepo: Pick<TaskRepo, 'createTask' | 'getTask' | 'listTasks' | 'setActiveSkillsBlock' | 'updateTask'>;
  registry: Pick<RegistryService, 'list' | 'installAndEnable'>;
  scheduler: Pick<SchedulerService, 'enqueueTaskWake'>;
  /** The config store the inbox heartbeat reads the triage hold from. */
  configStore: Pick<ConfigStore, 'get' | 'set'>;
  /** The process's shared onboarding state lock (createOnboardingStateLock): every state write takes it. */
  stateLock: OnboardingStateLock;
  workingDocsRepo: WorkingDocsRepo;
  principalName: () => Promise<string | null>;
  /** The principal's contact id, which the onboarding tasks wait on; null when there is none. */
  principalContactId: () => Promise<string | null>;
  /** Whether the principal contact has a verified, active identity on the channel (setup's check). */
  principalHasIdentity: (channel: 'signal' | 'sms' | 'slack') => Promise<boolean>;
  /** APP_ORIGIN: the address the phone app invitation opens. */
  appOrigin: string | undefined;
  /** Exits the process so the supervisor restarts it (setupRoutes' mechanism). */
  scheduleProcessExit: (delayMs: number) => void;
  /**
   * Whether this process loaded the agent or skill bundle at boot. Agents and bundles load only at
   * startup, so anything onboarding needs that is not loaded here needs a restart, whether this
   * start enabled it or an earlier one did.
   */
  loadedAtBoot: (kind: RegistryKind, name: string) => boolean;
  /**
   * Whether `configStore` persists (the knowledge graph is on). Without it the run state and the
   * triage hold are lost at the restart Start may trigger, so Start is refused.
   */
  persistentStore: boolean;
  logger: Logger;
  /** Defaults to the pairing-invitations mint on `pool`. */
  mintInvitation?: (origin: string) => Promise<Pick<MintedInvitation, 'id' | 'pairUrl' | 'expiresAt'>>;
  /** Defaults to the pairing-invitations stop-by-id on `pool`. */
  stopInvitation?: (id: string) => Promise<boolean>;
  now?: () => Date;
  newId?: () => string;
}

type Reach = { route: 'app'; origin: string } | { route: Exclude<MessagingRoute, 'app'> };

export class OnboardingService {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly mint: (origin: string) => Promise<Pick<MintedInvitation, 'id' | 'pairUrl' | 'expiresAt'>>;
  private readonly stop: (id: string) => Promise<boolean>;

  constructor(private readonly deps: OnboardingServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? randomUUID;
    this.mint = deps.mintInvitation ?? ((origin) => mintPairingInvitation(deps.pool, origin));
    this.stop = deps.stopInvitation ?? ((id) => stopPairingInvitation(deps.pool, id));
  }

  async status(): Promise<OnboardingStatus> {
    const { pool, taskRepo, configStore, logger } = this.deps;
    const [setup, task, state, principalName, triageHeld] = await Promise.all([
      readSetupState(pool, logger),
      findOpenOnboardingTask(taskRepo),
      readOnboardingState(configStore, logger),
      this.deps.principalName(),
      isTriageHeld(configStore, logger),
    ]);
    // Started while an onboarding task is open, or once one completed: the alert must not come
    // back. A cancelled onboarding (or a failed start's) is not started, so Start is offered again.
    const completedTaskId = task === null && state !== null ? await this.completedTaskId(state.taskId) : null;
    const started = task !== null || completedTaskId !== null;
    return {
      started,
      taskId: task?.id ?? completedTaskId,
      // Only an install whose Setup finished on the Setup page. Migration 132 marks an install
      // that predates the page complete too, but a completed Setup always chose a messaging
      // route (the checklist requires it) and a pre-Setup install never did, so its absence is
      // what keeps the alert off those installs (#2709).
      showDashboardAlert: !started && setup.phase === 'complete' && setup.messagingRoute !== null,
      workingPrincipalSignals: await this.workingPrincipalSignals(setup.completedAt),
      route: setup.messagingRoute,
      setupFor: setup.setupFor,
      principalName,
      triageHeld,
    };
  }

  /** `taskId` when that task is done (onboarding completed), else null. */
  private async completedTaskId(taskId: string): Promise<string | null> {
    const row = await this.deps.taskRepo.getTask(taskId);
    return row?.status === 'done' ? row.id : null;
  }

  /** Stop an invitation Start minted (a caller whose audit of it failed). True when it was live. */
  stopInvitation(id: string): Promise<boolean> {
    return this.stop(id);
  }

  /** Release the triage hold (the console does this when Email triage is switched on). */
  releaseTriageHold(): Promise<void> {
    return releaseTriageHold(this.deps.configStore);
  }

  /** The principal's display name, or "the principal" when none is recorded. */
  async principalDisplayName(): Promise<string> {
    return (await this.deps.principalName())?.trim() || 'the principal';
  }

  /** The install's playbook, seeded from the default if missing. */
  playbook(): Promise<PlaybookSession[]> {
    return readPlaybook(this.deps.workingDocsRepo, this.deps.logger);
  }

  /** Who Setup was for and the operator's name, as Setup recorded them (absent operator means 'self'). */
  async setupContext(): Promise<{ setupFor: SetupFor | null; operatorName: string | null }> {
    const setup = await readSetupState(this.deps.pool, this.deps.logger);
    return { setupFor: setup.setupFor, operatorName: setup.operatorName?.trim() || null };
  }

  /** The onboarding run state, or null before any start. */
  readState(): Promise<OnboardingState | null> {
    return readOnboardingState(this.deps.configStore, this.deps.logger);
  }

  /**
   * Record that the greeting reached the principal. Keeps an earlier time (follow-ups are not
   * the greeting). Null when onboarding has no state.
   */
  async markGreetingSent(): Promise<string | null> {
    const at = this.now().toISOString();
    const { state } = await updateOnboardingState(this.deps, (s) => (s.greetingSentAt ? null : { ...s, greetingSentAt: at }));
    return state?.greetingSentAt ?? null;
  }

  /**
   * Create the subtasks of one playbook session under the onboarding task. Idempotent: a topic
   * that already has a subtask (in any status) is not created again, so a second call creates
   * nothing and a call after a part-way failure fills the gaps.
   */
  async openSession(parent: TaskRow, sessionId: string): Promise<OpenSessionResult> {
    return this.inLockedTransaction(OPEN_SESSION_LOCK_KEY, async () => {
      const sessions = (await this.playbook()).filter((s) => s.id !== RECURRING_SESSION);
      const session = sessions.find((s) => s.id === sessionId);
      if (!session) return { ok: false, code: 'unknown_session', sessionIds: sessions.map((s) => s.id) };
      const existing = await this.deps.taskRepo.listTasks({
        parentTaskId: parent.id,
        tag: `onboarding:session:${session.id}`,
        createdBy: ONBOARDING_CREATED_BY,
        limit: 200,
      });
      const existingTopicIds = new Set(topicSubtasks(existing, this.deps.logger).map((s) => s.topicId));
      const parked = await this.parkedOnPrincipal();
      const createdSubtasks = await this.createSessionSubtasks(parent, session, parked, [], existingTopicIds);
      return { ok: true, session, createdSubtasks };
    });
  }

  async start(opts: StartOptions): Promise<StartResult> {
    const { pool, logger } = this.deps;
    let locked: LockedStart;
    try {
      locked = await this.inLockedTransaction(
        START_LOCK_KEY,
        (client) => this.startLocked(client, opts),
        // A failed COMMIT rolls back the rotation, but not what went through other connections.
        async (out) => {
          if (out.undo) await this.undoFailedStart(out.undo);
        },
      );
    } catch (err) {
      if (isLockTimeout(err)) {
        logger.warn('onboarding: another start held the lock past its timeout — refusing this one');
        return { ok: false, code: 'start_in_progress' };
      }
      throw err;
    }
    const { result, rotatedTo } = locked;

    // Only after the commit: a rolled-back rotation must never reach the cache.
    if (rotatedTo) noteWebThreadRotated(pool, rotatedTo);
    if (result.ok && result.restartScheduled) {
      // A principal start leaves the calling turn time to say Curia will be back.
      const delayMs = opts.actor === 'principal' ? PRINCIPAL_RESTART_EXIT_DELAY_SECONDS * 1000 : RESTART_EXIT_DELAY_MS;
      logger.warn({ taskId: result.taskId, delayMs }, 'onboarding: capabilities need loading, scheduling a restart');
      try {
        this.deps.scheduleProcessExit(delayMs);
      } catch (err) {
        // The wakes are queued and fire on the next boot whenever it happens.
        logger.error({ err }, 'onboarding: scheduleProcessExit threw — the restart will not occur');
      }
    }
    return result;
  }

  /**
   * Run `fn` in a transaction holding a transaction-scoped advisory lock on `key`, so concurrent
   * callers serialize. Task rows written through TaskRepo use other connections (autocommit), so
   * when `fn` succeeded but COMMIT failed, `onCommitFailure` gets its result to undo them.
   */
  private async inLockedTransaction<T>(
    key: string,
    fn: (client: PoolClient) => Promise<T>,
    onCommitFailure?: (out: T) => Promise<void>,
  ): Promise<T> {
    const client = await this.deps.pool.connect();
    // Set when ROLLBACK fails: the connection may still hold the lock, so destroy it.
    let discard: Error | undefined;
    let produced: { out: T } | null = null;
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('lock_timeout', $1, true)`, [START_LOCK_TIMEOUT]);
      // Same key hashing as KnowledgeGraphStore.withAdvisoryLock; held until COMMIT/ROLLBACK.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
      const out = await fn(client);
      produced = { out };
      await client.query('COMMIT');
      return out;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        discard = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr));
        this.deps.logger.error({ err: rollbackErr, key }, 'onboarding: rollback failed — discarding the connection');
      }
      if (produced && onCommitFailure) {
        this.deps.logger.error({ err, key }, 'onboarding: COMMIT failed — undoing what went through other connections');
        await onCommitFailure(produced.out);
      }
      throw err;
    } finally {
      client.release(discard);
    }
  }

  private async startLocked(client: PoolClient, opts: StartOptions): Promise<LockedStart> {
    const { pool, taskRepo, configStore, logger } = this.deps;
    const refuse = (code: Extract<StartResult, { ok: false }>['code'], signals?: string[]): LockedStart => ({
      result: { ok: false as const, code, ...(signals ? { signals } : {}) },
      rotatedTo: null,
      undo: null,
    });

    const setup = await readSetupState(pool, logger);
    if (setup.phase !== 'complete') return refuse('setup_incomplete');
    if (!this.deps.persistentStore) {
      logger.warn('onboarding: the knowledge graph is off — the run state would not survive a restart, refusing Start');
      return refuse('no_persistent_store');
    }
    if (await findOpenOnboardingTask(taskRepo)) return refuse('already_started');

    const signals = await this.workingPrincipalSignals(setup.completedAt);
    if (signals.length > 0 && !opts.confirmWorkingPrincipal) return refuse('confirm_working_principal', signals);

    // A principal asking in conversation is already reachable: Curia does not reach out.
    const inConversation = opts.actor === 'principal';
    let reach: Reach | null = null;
    if (!inConversation) {
      reach = await this.resolveReach(setup.messagingRoute);
      if (!reach) return refuse('route_unreachable');
    }
    // A pre-Setup install (marked complete by migration 132) has no messaging route; a principal
    // start records none.
    const route = reach?.route ?? setup.messagingRoute;
    // On Signal, SMS and Slack the parent wakes to send the greeting; the app route waits for redemption.
    const greetOnWake = reach !== null && reach.route !== 'app';

    // Read before changing anything, so a failed start puts them back.
    const undo: StartUndo = {
      created: [],
      mintedId: null,
      priorHeld: await isTriageHeld(configStore, logger),
      enabledTriageAgent: false,
      priorStateRaw: await readOnboardingStateRaw(configStore),
      stateWritten: false,
    };
    try {
      await setTriageHold(configStore);
      await this.enableRequiredEntries(undo);
      // Whatever this process did not load at boot needs a restart, whoever enabled it.
      const restartScheduled = REQUIRED_ENTRIES.some(({ kind, name }) => !this.deps.loadedAtBoot(kind, name));
      const principalName = await this.principalDisplayName();
      const sessions = await this.playbook();

      // The parent wakes to greet (operator start, messaging route) or, when a principal start
      // restarts Curia mid-conversation, to pick the conversation back up.
      const parentNote = greetOnWake
        ? GREETING_NOTE
        : inConversation && restartScheduled ? RESTART_RESUME_NOTE : undefined;
      const { parent, homework } = await this.createTaskTree(principalName, sessions, parentNote, undo.created);

      // Rotating would wipe the conversation a principal start comes from, so only when they
      // asked from another channel (their first app view must not be the operator's Setup chat).
      let rotatedTo: string | null = null;
      const rotate = !inConversation || (opts.channelId !== undefined && opts.channelId !== WEB_CHANNEL_ID);
      if (rotate) {
        rotatedTo = this.newId();
        await rotateWebThreadRow(client, rotatedTo);
      }

      let invitation: StartedInvitation | null = null;
      if (reach?.route === 'app') {
        const minted = await this.mint(reach.origin);
        undo.mintedId = minted.id;
        invitation = { id: minted.id, url: minted.pairUrl, expiresAt: minted.expiresAt };
      }

      // After a restart the wakes run on the new process.
      const startedAt = this.now();
      const runAt = restartScheduled
        ? new Date(startedAt.getTime() + RESTART_WAKE_DELAY_SECONDS * 1000)
        : startedAt;
      await this.wake(homework.id, runAt);
      if (parentNote) await this.wake(parent.id, runAt);

      // Last, once the wakes are queued: a start that failed leaves no state saying it started.
      undo.stateWritten = true;
      // Whole-value write, under the state lock so no concurrent update lands half on top of it.
      await this.deps.stateLock(() => writeOnboardingState(configStore, {
        taskId: parent.id,
        startedAt: startedAt.toISOString(),
        route,
        greetingSentAt: inConversation ? startedAt.toISOString() : null,
        followUpsSent: 0,
        lastFollowUpAt: null,
        lastPrincipalTurnAt: null,
        idleNudgeSentAt: null,
        greetingNudgedAt: null,
        // The watcher knows this run's link by its id (see OnboardingWatcher.tick).
        invitationId: invitation?.id ?? null,
        operatorNotified: [],
      }));

      logger.info(
        { taskId: parent.id, actor: opts.actor, route, subtasks: undo.created.length - 2, restartScheduled, rotated: rotate },
        'onboarding: started',
      );
      return { result: { ok: true, taskId: parent.id, invitation, restartScheduled }, rotatedTo, undo };
    } catch (err) {
      await this.undoFailedStart(undo);
      throw err;
    }
  }

  /** Signals that the principal already uses this install. */
  private async workingPrincipalSignals(completedAt: Date | null): Promise<string[]> {
    const signals: string[] = [];
    const agents = await this.deps.registry.list('agent');
    if (agents.some((a) => a.name === EMAIL_TRIAGE_AGENT && a.state === 'enabled')) {
      signals.push(WORKING_PRINCIPAL_SIGNALS.emailTriageEnabled);
    }
    // The principal's own tasks from before Setup finished (or ever, where it never finished on the page).
    const prior = await this.deps.pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM tasks WHERE source = 'ceo' AND created_at < COALESCE($1::timestamptz, now())
       ) AS exists`,
      [completedAt],
    );
    if (prior.rows[0]?.exists) signals.push(WORKING_PRINCIPAL_SIGNALS.priorPrincipalTasks);
    return signals;
  }

  /** How Curia reaches the principal, or null when it cannot on the Setup route. */
  private async resolveReach(route: MessagingRoute | null): Promise<Reach | null> {
    const { logger } = this.deps;
    if (!route) {
      logger.warn('onboarding: no messaging route chosen in Setup — cannot reach the principal');
      return null;
    }
    if (route === 'app') {
      const origin = choosePairOrigin({ appOrigin: this.deps.appOrigin }).origin;
      if (!origin) {
        logger.warn('onboarding: APP_ORIGIN is not set — cannot mint the phone app invitation');
        return null;
      }
      return { route, origin };
    }
    if (!(await this.deps.principalHasIdentity(route))) {
      logger.warn({ route }, 'onboarding: the principal has no verified identity on the messaging route');
      return null;
    }
    return { route };
  }

  /**
   * Enable what onboarding needs. Flags `undo.enabledTriageAgent` the moment this call newly
   * enables the Email triage agent, so a later enable that throws still keeps triage held (a
   * mailbox nobody was told about must not start).
   */
  private async enableRequiredEntries(undo: StartUndo): Promise<void> {
    const { registry } = this.deps;
    const enabledByKind = new Map<RegistryKind, Set<string>>();
    for (const { kind, name } of REQUIRED_ENTRIES) {
      let enabled = enabledByKind.get(kind);
      if (!enabled) {
        enabled = new Set((await registry.list(kind)).filter((e) => e.state === 'enabled').map((e) => e.name));
        enabledByKind.set(kind, enabled);
      }
      if (enabled.has(name)) continue;
      const isTriageAgent = kind === 'agent' && name === EMAIL_TRIAGE_AGENT;
      // Flagged before the call: installAndEnable commits the enable and then reads the entry
      // back, so a throw does not prove the agent stayed disabled. The flag is cleared only when
      // a fresh read shows it is not enabled; when that cannot be read either, the hold stays.
      if (isTriageAgent) undo.enabledTriageAgent = true;
      try {
        await registry.installAndEnable(kind, name, ONBOARDING_CREATED_BY);
      } catch (err) {
        if (isTriageAgent) undo.enabledTriageAgent = await this.triageAgentMayBeEnabled();
        throw err;
      }
      enabled.add(name);
    }
  }

  /** After a failed enable: false only when the registry shows the Email triage agent not enabled. */
  private async triageAgentMayBeEnabled(): Promise<boolean> {
    try {
      const agents = await this.deps.registry.list('agent');
      return agents.some((a) => a.name === EMAIL_TRIAGE_AGENT && a.state === 'enabled');
    } catch (err) {
      this.deps.logger.error({ err }, 'onboarding: could not read whether Email triage was enabled — keeping triage held');
      return true;
    }
  }

  private async createTaskTree(
    principalName: string,
    sessions: PlaybookSession[],
    progressNote: string | undefined,
    created: string[],
  ): Promise<{ parent: TaskRow; homework: TaskRow }> {
    const { taskRepo, logger } = this.deps;
    const parked = await this.parkedOnPrincipal();

    const parent = await taskRepo.createTask({
      ...TASK_BASE,
      ...parked,
      title: `Onboarding: getting to know ${principalName}`,
      description:
        `Get to know ${principalName}. Each subtask is a First conversation topic from ` +
        `/meetings/onboarding/playbook.md.`,
      tags: [ONBOARDING_TASK_TAG],
      originator: makeSystemOriginator(),
      ...(progressNote ? { progressNote } : {}),
    });
    created.push(parent.id);
    await this.activateOnboardingSkill(parent.id);

    const session = sessions.find((s) => s.id === FIRST_CONVERSATION_SESSION);
    if (session) {
      await this.createSessionSubtasks(parent, session, parked, created);
    } else {
      logger.warn({ taskId: parent.id }, 'onboarding: the playbook has no First conversation session — no subtasks created');
    }

    const homework = await taskRepo.createTask({
      ...TASK_BASE,
      title: `Homework: research ${principalName} and map shared drives`,
      description: homeworkDescription(principalName),
      parentTaskId: parent.id,
      parentTask: parent,
      tags: [ONBOARDING_TASK_TAG, 'onboarding:homework'],
      originator: makeSystemOriginator(),
    });
    created.push(homework.id);
    await this.activateOnboardingSkill(homework.id);
    return { parent, homework };
  }

  /**
   * One subtask per topic of `session`, skipping topics in `skipTopicIds`. The operator edits the
   * playbook, so a topic with no id, or a repeated one, is skipped with a warning. Returns how many
   * subtasks were created; their ids are appended to `created`.
   */
  private async createSessionSubtasks(
    parent: TaskRow,
    session: PlaybookSession,
    parked: ParkedOnPrincipal,
    created: string[],
    skipTopicIds: ReadonlySet<string> = new Set(),
  ): Promise<number> {
    const { taskRepo, logger } = this.deps;
    if (session.topics.length === 0) {
      logger.warn({ taskId: parent.id, sessionId: session.id }, 'onboarding: the playbook session has no topics — no subtasks created');
    }
    const seen = new Set<string>();
    let count = 0;
    for (const topic of session.topics) {
      if (!topic.id) {
        logger.warn({ title: topic.title, sessionId: session.id }, 'onboarding: playbook topic has no id — skipped');
        continue;
      }
      if (seen.has(topic.id)) {
        logger.warn({ topicId: topic.id, title: topic.title, sessionId: session.id }, 'onboarding: duplicate playbook topic id — skipped');
        continue;
      }
      seen.add(topic.id);
      if (skipTopicIds.has(topic.id)) continue;
      const sub = await taskRepo.createTask({
        ...TASK_BASE,
        ...parked,
        title: topic.title,
        parentTaskId: parent.id,
        parentTask: parent,
        tags: topicSubtaskTags(session.id, topic.id),
        originator: makeSystemOriginator(),
      });
      created.push(sub.id);
      count++;
    }
    return count;
  }

  /** See {@link ParkedOnPrincipal}. */
  private async parkedOnPrincipal(): Promise<ParkedOnPrincipal> {
    const contactId = await this.deps.principalContactId();
    if (!contactId) {
      this.deps.logger.warn('onboarding: no principal contact — onboarding tasks are created open, and the backlog heartbeat may wake them');
      return {};
    }
    return { status: 'waiting', waitingOnContactId: contactId };
  }

  private async activateOnboardingSkill(taskId: string): Promise<void> {
    const written = await this.deps.taskRepo.setActiveSkillsBlock(taskId, replaceActiveSkillsBlock([ONBOARDING_SKILL]));
    if ('ok' in written && !written.ok) {
      throw new Error(`onboarding: could not set the active skill on task ${taskId}: ${written.code}`);
    }
  }

  private async wake(taskId: string, runAt: Date): Promise<void> {
    await this.deps.scheduler.enqueueTaskWake({
      taskId,
      agentId: 'coordinator',
      runAt,
      createdBy: ONBOARDING_CREATED_BY,
      originator: makeSystemOriginator(),
    });
  }

  /**
   * A start that failed part-way, or whose COMMIT failed: stop the invitation it minted so no
   * 48-hour credential outlives it, put the triage hold back as it was (kept on if this start
   * newly enabled Email triage), restore the run state it overwrote, and cancel the tasks it
   * created so a retry can start again. With no earlier state, the new one is left pointing at a
   * cancelled task, which status reads as not started. Registry entries it enabled stay enabled;
   * a retry restarts Curia if this process has not loaded them. Never throws.
   */
  private async undoFailedStart(undo: StartUndo): Promise<void> {
    const { configStore, logger } = this.deps;
    if (undo.mintedId) {
      try {
        await this.stop(undo.mintedId);
      } catch (err) {
        logger.error(
          { err, pairingInvitationId: undo.mintedId },
          'onboarding: failed to stop the invitation from a failed start — it stays live until it expires',
        );
      }
    }
    const held = undo.priorHeld || undo.enabledTriageAgent;
    try {
      await writeTriageHold(configStore, held);
    } catch (err) {
      logger.error({ err, held }, 'onboarding: failed to restore the triage hold after a failed start');
    }
    if (undo.stateWritten && undo.priorStateRaw !== null) {
      try {
        const priorStateRaw = undo.priorStateRaw;
        await this.deps.stateLock(() => writeOnboardingStateRaw(configStore, priorStateRaw));
      } catch (err) {
        logger.error({ err }, 'onboarding: failed to restore the run state after a failed start');
      }
    }
    // Children first, then the parent (created first), so no open child outlives it.
    for (const taskId of [...undo.created].reverse()) {
      try {
        await this.deps.taskRepo.updateTask(taskId, {
          status: 'cancelled',
          progressNote: 'Onboarding start failed part-way; cancelled.',
        });
      } catch (err) {
        logger.error({ err, taskId }, 'onboarding: failed to cancel a task from a failed start');
      }
    }
  }
}

/** Whether `err` is Postgres lock_not_available (the advisory lock wait timed out). */
function isLockTimeout(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === LOCK_NOT_AVAILABLE;
}

function homeworkDescription(principalName: string): string {
  return [
    `Research ${principalName}'s professional public footprint: company and what it does, role, city, ` +
      'public bio, recent news. Not family, home or personal social accounts.',
    'Write the research brief to /meetings/onboarding/research-brief.md: each finding with its source, ' +
      'every item marked unconfirmed, and say so where a result may be a namesake.',
    "Then, if Curia's Google Workspace is signed in, list the shared drives and their top-level folders " +
      '(names only) for the drives-and-imports topic.',
  ].join('\n\n');
}
