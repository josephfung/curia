// onboarding-service.ts — starting onboarding and reporting whether it has started (#2360).
//
// Start is one path for every caller (the console's Start button, and later the coordinator's
// onboarding-start tool): it holds triage, enables the capabilities onboarding needs, creates
// the onboarding task tree from the playbook, rotates the web thread and reaches the principal.
// No message is sent from here: on Signal, SMS and Slack the parent task is woken with a
// "Send the greeting" note and the coordinator composes it; on the app route the greeting
// waits for the invitation to be redeemed.
//
// Idempotency: the whole start runs under a transaction-scoped advisory lock, so two presses
// (double click, two tabs) serialize and the second sees the first's committed task and
// answers already_started. Task rows are written through TaskRepo on other pool connections
// (autocommit), so a failure part-way cancels the tasks this start created rather than
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
import { readSetupState, type MessagingRoute, type SetupFor } from '../setup/setup-state.js';
import { readPlaybook, type PlaybookSession } from './playbook.js';
import { findOpenOnboardingTask, readOnboardingState, writeOnboardingState, ONBOARDING_TASK_TAG } from './state.js';
import { releaseTriageHold, setTriageHold } from './triage-hold.js';
import { ONBOARDING_CREATED_BY, RESTART_WAKE_DELAY_SECONDS } from './constants.js';

/** Signals that the install is already in use, so starting onboarding needs confirming. */
export const WORKING_PRINCIPAL_SIGNALS = {
  emailTriageEnabled: 'email_triage_enabled',
  priorPrincipalTasks: 'prior_principal_tasks',
} as const;

/** The playbook session whose topics become the onboarding task's subtasks. */
const FIRST_CONVERSATION_SESSION = 'first-conversation';
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
/** Longest a start waits for a concurrent one before failing (Postgres interval). */
const START_LOCK_TIMEOUT = '10s';
/** Delay before the restart exit, so the HTTP reply flushes first (as setupRoutes does). */
const RESTART_EXIT_DELAY_MS = 500;
const GREETING_NOTE = 'Send the greeting';

export type OnboardingStatus = {
  started: boolean;
  taskId: string | null;
  showDashboardAlert: boolean;
  workingPrincipalSignals: string[];
  route: MessagingRoute | null;
  setupFor: SetupFor | null;
  principalName: string | null;
};

export type StartResult =
  | { ok: true; taskId: string; invitation: StartedInvitation | null; restartScheduled: boolean }
  | {
      ok: false;
      code: 'already_started' | 'confirm_working_principal' | 'setup_incomplete' | 'route_unreachable';
      signals?: string[];
    };

/** The phone app invitation Start minted; `id` lets a caller stop it (e.g. its audit failed). */
export type StartedInvitation = { id: string; url: string; expiresAt: string };

export type StartOptions = { actor: 'operator' | 'principal'; confirmWorkingPrincipal?: boolean };

export interface OnboardingServiceDeps {
  pool: Pool;
  taskRepo: Pick<TaskRepo, 'createTask' | 'listTasks' | 'setActiveSkillsBlock' | 'updateTask'>;
  registry: Pick<RegistryService, 'list' | 'installAndEnable'>;
  scheduler: Pick<SchedulerService, 'enqueueTaskWake'>;
  /** The config store the inbox heartbeat reads the triage hold from. */
  configStore: Pick<ConfigStore, 'get' | 'set'>;
  workingDocsRepo: WorkingDocsRepo;
  principalName: () => Promise<string | null>;
  /** Whether the principal contact has a verified, active identity on the channel (setup's check). */
  principalHasIdentity: (channel: 'signal' | 'sms' | 'slack') => Promise<boolean>;
  /** APP_ORIGIN: the address the phone app invitation opens. */
  appOrigin: string | undefined;
  /** Exits the process so the supervisor restarts it (setupRoutes' mechanism). */
  scheduleProcessExit: (delayMs: number) => void;
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
    const [setup, task, state, principalName] = await Promise.all([
      readSetupState(pool),
      findOpenOnboardingTask(taskRepo),
      readOnboardingState(configStore, logger),
      this.deps.principalName(),
    ]);
    // Started once a start has run, even after its task is done: the alert must not come back.
    const started = task !== null || state !== null;
    return {
      started,
      taskId: task?.id ?? state?.taskId ?? null,
      // Only an install whose Setup finished on the Setup page (completed_at set there, not by
      // migration 130), so installs that predate the page never see it.
      showDashboardAlert: !started && setup.phase === 'complete' && setup.completedAt !== null,
      workingPrincipalSignals: await this.workingPrincipalSignals(setup.completedAt),
      route: setup.messagingRoute,
      setupFor: setup.setupFor,
      principalName,
    };
  }

  /** Stop an invitation Start minted (a caller whose audit of it failed). True when it was live. */
  stopInvitation(id: string): Promise<boolean> {
    return this.stop(id);
  }

  /** Release the triage hold (the console does this when Email triage is switched on). */
  releaseTriageHold(): Promise<void> {
    return releaseTriageHold(this.deps.configStore);
  }

  async start(opts: StartOptions): Promise<StartResult> {
    const { pool, logger } = this.deps;
    const client = await pool.connect();
    // Set when ROLLBACK fails: the connection may still hold the lock, so destroy it.
    let discard: Error | undefined;
    let rotatedTo: string | null = null;
    let result: StartResult;
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('lock_timeout', $1, true)`, [START_LOCK_TIMEOUT]);
      // Same key hashing as KnowledgeGraphStore.withAdvisoryLock; held until COMMIT/ROLLBACK.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [START_LOCK_KEY]);
      const locked = await this.startLocked(client, opts);
      await client.query('COMMIT');
      result = locked.result;
      rotatedTo = locked.rotatedTo;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        discard = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr));
        logger.error({ err: rollbackErr }, 'onboarding: start rollback failed — discarding the connection');
      }
      throw err;
    } finally {
      client.release(discard);
    }

    // Only after the commit: a rolled-back rotation must never reach the cache.
    if (rotatedTo) noteWebThreadRotated(pool, rotatedTo);
    if (result.ok && result.restartScheduled) {
      logger.warn({ taskId: result.taskId }, 'onboarding: capabilities enabled, scheduling a restart');
      try {
        this.deps.scheduleProcessExit(RESTART_EXIT_DELAY_MS);
      } catch (err) {
        // The wakes are queued and fire on the next boot whenever it happens.
        logger.error({ err }, 'onboarding: scheduleProcessExit threw — the restart will not occur');
      }
    }
    return result;
  }

  private async startLocked(
    client: PoolClient,
    opts: StartOptions,
  ): Promise<{ result: StartResult; rotatedTo: string | null }> {
    const { pool, taskRepo, configStore, logger } = this.deps;
    const refuse = (code: Extract<StartResult, { ok: false }>['code'], signals?: string[]) => ({
      result: { ok: false as const, code, ...(signals ? { signals } : {}) },
      rotatedTo: null,
    });

    const setup = await readSetupState(pool);
    if (setup.phase !== 'complete') return refuse('setup_incomplete');
    if (await findOpenOnboardingTask(taskRepo)) return refuse('already_started');

    const signals = await this.workingPrincipalSignals(setup.completedAt);
    if (signals.length > 0 && !opts.confirmWorkingPrincipal) return refuse('confirm_working_principal', signals);

    const reach = await this.resolveReach(setup.messagingRoute);
    if (!reach) return refuse('route_unreachable');

    await setTriageHold(configStore);
    const created: string[] = [];
    let mintedId: string | null = null;
    try {
      const restartScheduled = await this.enableRequiredEntries();
      const principalName = (await this.deps.principalName())?.trim() || 'the principal';
      const sessions = await readPlaybook(this.deps.workingDocsRepo, logger);

      const { parent, homework } = await this.createTaskTree(principalName, sessions, reach, created);

      const rotatedTo = this.newId();
      await rotateWebThreadRow(client, rotatedTo);

      let invitation: StartedInvitation | null = null;
      if (reach.route === 'app') {
        const minted = await this.mint(reach.origin);
        mintedId = minted.id;
        invitation = { id: minted.id, url: minted.pairUrl, expiresAt: minted.expiresAt };
      }

      const startedAt = this.now();
      await writeOnboardingState(configStore, {
        taskId: parent.id,
        startedAt: startedAt.toISOString(),
        route: reach.route,
        greetingSentAt: null,
        followUpsSent: 0,
        lastFollowUpAt: null,
        lastPrincipalTurnAt: null,
        idleNudgeSentAt: null,
        operatorNotified: [],
      });

      // Last, so nothing wakes for a start that failed. After a restart the wakes run on the new process.
      const runAt = restartScheduled
        ? new Date(startedAt.getTime() + RESTART_WAKE_DELAY_SECONDS * 1000)
        : startedAt;
      await this.wake(homework.id, runAt);
      if (reach.route !== 'app') await this.wake(parent.id, runAt);

      logger.info(
        { taskId: parent.id, actor: opts.actor, route: reach.route, subtasks: created.length - 2, restartScheduled },
        'onboarding: started',
      );
      return { result: { ok: true, taskId: parent.id, invitation, restartScheduled }, rotatedTo };
    } catch (err) {
      await this.undoFailedStart(created, mintedId);
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

  /** Enable what onboarding needs. True when anything was newly enabled (a restart loads it). */
  private async enableRequiredEntries(): Promise<boolean> {
    const { registry } = this.deps;
    const enabledByKind = new Map<RegistryKind, Set<string>>();
    let newlyEnabled = false;
    for (const { kind, name } of REQUIRED_ENTRIES) {
      let enabled = enabledByKind.get(kind);
      if (!enabled) {
        enabled = new Set((await registry.list(kind)).filter((e) => e.state === 'enabled').map((e) => e.name));
        enabledByKind.set(kind, enabled);
      }
      if (enabled.has(name)) continue;
      await registry.installAndEnable(kind, name, ONBOARDING_CREATED_BY);
      enabled.add(name);
      newlyEnabled = true;
    }
    return newlyEnabled;
  }

  private async createTaskTree(
    principalName: string,
    sessions: PlaybookSession[],
    reach: Reach,
    created: string[],
  ): Promise<{ parent: TaskRow; homework: TaskRow }> {
    const { taskRepo, logger } = this.deps;
    const base = {
      agentId: 'coordinator',
      owner: 'curia' as const,
      source: 'scheduler' as const,
      createdBy: ONBOARDING_CREATED_BY,
    };

    const parent = await taskRepo.createTask({
      ...base,
      title: `Onboarding: getting to know ${principalName}`,
      description:
        `Get to know ${principalName}. Each subtask is a First conversation topic from ` +
        `/meetings/onboarding/playbook.md.`,
      tags: [ONBOARDING_TASK_TAG],
      originator: makeSystemOriginator(),
      ...(reach.route !== 'app' ? { progressNote: GREETING_NOTE } : {}),
    });
    created.push(parent.id);
    await this.activateOnboardingSkill(parent.id);

    const session = sessions.find((s) => s.id === FIRST_CONVERSATION_SESSION);
    if (!session || session.topics.length === 0) {
      logger.warn({ taskId: parent.id }, 'onboarding: the playbook has no First conversation topics — no subtasks created');
    }
    const seen = new Set<string>();
    for (const topic of session?.topics ?? []) {
      // The operator edits the playbook: a topic with no id, or a repeated one, is skipped.
      if (!topic.id) {
        logger.warn({ title: topic.title }, 'onboarding: playbook topic has no id — skipped');
        continue;
      }
      if (seen.has(topic.id)) {
        logger.warn({ topicId: topic.id, title: topic.title }, 'onboarding: duplicate playbook topic id — skipped');
        continue;
      }
      seen.add(topic.id);
      const sub = await taskRepo.createTask({
        ...base,
        title: topic.title,
        parentTaskId: parent.id,
        parentTask: parent,
        tags: [ONBOARDING_TASK_TAG, `onboarding:topic:${topic.id}`, `onboarding:session:${FIRST_CONVERSATION_SESSION}`],
        originator: makeSystemOriginator(),
      });
      created.push(sub.id);
    }

    const homework = await taskRepo.createTask({
      ...base,
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
   * A start that failed part-way: cancel the tasks it created so a retry can start again, and
   * lift the triage hold so a mailbox already being triaged is not left held with no onboarding,
   * and stop the invitation it minted so no 48-hour credential outlives a failed start.
   * Registry entries it enabled stay enabled (harmless, and a retry skips them).
   */
  private async undoFailedStart(taskIds: string[], mintedInvitationId: string | null): Promise<void> {
    if (mintedInvitationId) {
      try {
        await this.stop(mintedInvitationId);
      } catch (err) {
        this.deps.logger.error(
          { err, pairingInvitationId: mintedInvitationId },
          'onboarding: failed to stop the invitation from a failed start — it stays live until it expires',
        );
      }
    }
    try {
      await releaseTriageHold(this.deps.configStore);
    } catch (err) {
      this.deps.logger.error({ err }, 'onboarding: failed to release the triage hold after a failed start');
    }
    // Children first, then the parent (created first), so no open child outlives it.
    for (const taskId of [...taskIds].reverse()) {
      try {
        await this.deps.taskRepo.updateTask(taskId, {
          status: 'cancelled',
          progressNote: 'Onboarding start failed part-way; cancelled.',
        });
      } catch (err) {
        this.deps.logger.error({ err, taskId }, 'onboarding: failed to cancel a task from a failed start');
      }
    }
  }
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
