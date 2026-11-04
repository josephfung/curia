// tasks.ts — task CRUD for the web console.
//
// Moved off /api/kg/* (#872). Auth matches other console routes: session cookie
// or x-web-bootstrap-secret via assertSecret.

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { Logger } from '../../../logger.js';
import type { ContactService } from '../../../contacts/contact-service.js';
import { assertSecret, CONSOLE_RATE, type SessionStore } from '../session-auth.js';
import { resolveConsoleOriginator } from '../console-originator.js';
import { AGENT_NAME_RULE, isAgentName } from '../../../agents/agent-name.js';
import { isUuid } from '../../../util/uuid.js';
import { validateTaskErrorBudget } from '../../../tasks/task-error-budget.js';
import { TaskTerminalStateError, type TaskRepo } from '../../../db/task-repo.js';
import { OPEN_TASK_STATUSES } from '../../../agents/prompts/backlog-line.js';

export interface TaskRouteOptions {
  pool: Pool;
  logger: Logger;
  webAppBootstrapSecret: string | undefined;
  sessions: SessionStore;
  contactService: ContactService;
  /**
   * Status changes go through TaskRepo so wake-ups, child tasks and outreach
   * are reconciled. Absent only in tests that never change a task's status.
   */
  taskRepo?: Pick<TaskRepo, 'updateTask'>;
}

export async function taskRoutes(
  app: FastifyInstance,
  options: TaskRouteOptions,
): Promise<void> {
  const { pool, logger, webAppBootstrapSecret, sessions, contactService, taskRepo } = options;

  const validTaskStatuses = [
    // Legacy values used by the scheduler before task skills shipped
    'active', 'pending', 'paused', 'completed', 'failed',
    // Task-lifecycle values introduced by migration 049
    'open', 'in_progress', 'blocked', 'waiting', 'done', 'cancelled',
  ];
  // Full DB row shape for the tasks table (all columns post-migration-049).
  // The enriched variant (used for GET list) includes joined fields from
  // contacts and a correlated subquery for the next scheduled wake-up time.
  type DbTaskRow = {
    id: string;
    agent_id: string;
    title: string;
    intent_anchor: string;
    description: string | null;
    status: string;
    owner: string;
    priority: number;
    due_at: string | null;
    source: string;
    source_agent_id: string | null;
    tags: string[];
    waiting_on_contact_id: string | null;
    waiting_on_text: string | null;
    parent_task_id: string | null;
    blocked_by_task_id: string | null;
    progress: Record<string, unknown> | null;
    error_budget: Record<string, unknown> | null;
    conversation_id: string | null;
    created_at: string;
    updated_at: string;
    // Enriched fields — null on rows returned by the bare UPDATE RETURNING path.
    waiting_on_contact_name: string | null;
    next_wake_at: string | null;
  };

  // Columns used for bare SELECT / UPDATE RETURNING (no JOIN needed).
  const TASK_SELECT = `
    id, agent_id, title, intent_anchor, description, status, owner, priority,
    due_at, source, source_agent_id, tags, waiting_on_contact_id, waiting_on_text,
    parent_task_id, blocked_by_task_id, progress, error_budget, conversation_id,
    created_at, updated_at`;

  // Full enriched query for the GET list: joins contacts for display name and
  // uses a correlated subquery to surface the next pending scheduled wake-up.
  // Open tasks sort first, so the 500-row cap drops old closed tasks before any
  // open one: the home's Open tasks tile links to this list and must find them
  // all (#2350). The console sorts the rows itself, so this order only picks rows.
  const TASK_ENRICHED_QUERY = `
    SELECT
      t.id, t.agent_id, t.title, t.intent_anchor, t.description, t.status,
      t.owner, t.priority, t.due_at, t.source, t.source_agent_id, t.tags,
      t.waiting_on_contact_id, t.waiting_on_text, t.parent_task_id,
      t.blocked_by_task_id, t.progress, t.error_budget, t.conversation_id,
      t.created_at, t.updated_at,
      c.display_name AS waiting_on_contact_name,
      (SELECT COALESCE(sj.deferred_wake_at, sj.next_run_at) FROM scheduled_jobs sj
       WHERE sj.task_id = t.id
         AND (sj.status = 'pending' OR (sj.status = 'running' AND sj.deferred_wake_at IS NOT NULL))
       ORDER BY COALESCE(sj.deferred_wake_at, sj.next_run_at) ASC LIMIT 1) AS next_wake_at
    FROM tasks t
    LEFT JOIN contacts c ON c.id = t.waiting_on_contact_id
    ORDER BY (t.status = ANY($1::text[])) DESC, t.updated_at DESC
    LIMIT 500`;

  function serializeTask(row: DbTaskRow) {
    return {
      id: row.id,
      agentId: row.agent_id,
      title: row.title,
      intentAnchor: row.intent_anchor,
      description: row.description,
      status: row.status,
      owner: row.owner,
      priority: row.priority,
      dueAt: row.due_at,
      source: row.source,
      sourceAgentId: row.source_agent_id,
      tags: row.tags ?? [],
      waitingOnContactId: row.waiting_on_contact_id,
      waitingOnContactName: row.waiting_on_contact_name ?? null,
      waitingOnText: row.waiting_on_text,
      parentTaskId: row.parent_task_id,
      blockedByTaskId: row.blocked_by_task_id,
      nextWakeAt: row.next_wake_at ?? null,
      progress: row.progress ?? {},
      errorBudget: row.error_budget ?? {},
      conversationId: row.conversation_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  const validOwners = ['curia', 'ceo', 'external'];
  const validSources = ['ceo', 'agent', 'scheduler', 'coordinator'];

  app.get('/api/tasks', CONSOLE_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;
    try {
      const result = await pool.query(TASK_ENRICHED_QUERY, [OPEN_TASK_STATUSES]);
      return reply.send({
        tasks: result.rows.map((row) => serializeTask(row as DbTaskRow)),
      });
    } catch (err) {
      logger.error({ err }, 'tasks: GET /api/tasks failed');
      return reply.status(500).send({ error: 'Failed to load tasks.' });
    }
  });

  app.post('/api/tasks', CONSOLE_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;
    const body = request.body as {
      agentId?: unknown;
      title?: unknown;
      intentAnchor?: unknown;
      description?: unknown;
      status?: unknown;
      owner?: unknown;
      priority?: unknown;
      dueAt?: unknown;
      source?: unknown;
      sourceAgentId?: unknown;
      tags?: unknown;
      waitingOnText?: unknown;
      progress?: unknown;
      errorBudget?: unknown;
      conversationId?: unknown;
    };
    if (typeof body.agentId !== 'string' || body.agentId.trim().length === 0) {
      return reply.status(400).send({ error: 'agentId is required.' });
    }
    if (typeof body.intentAnchor !== 'string' || body.intentAnchor.trim().length === 0) {
      return reply.status(400).send({ error: 'intentAnchor is required.' });
    }
    const status = typeof body.status === 'string' ? body.status : 'open';
    if (!validTaskStatuses.includes(status)) {
      return reply.status(400).send({ error: 'Invalid status.' });
    }
    // Resolve with defaults first, then validate — avoids dual-layer guard maintenance trap.
    const owner = typeof body.owner === 'string' ? body.owner : 'curia';
    // Default source to 'ceo', not 'agent' (#1127). The console is a principal surface, so a task
    // created here with no explicit source is the original unit of principal-authorized work — NOT an
    // agent-spawned side-effect. selectHeartbeatCandidates derives `derived = source='agent' OR
    // parent_task_id IS NOT NULL`; a default of 'agent' would mark the task derived and the bypass
    // ladder would downgrade its principal lineage at posture B (70-89), stranding it propose-only
    // — defeating the originator stamp below. An explicit source from the client is still honoured.
    const source = typeof body.source === 'string' ? body.source : 'ceo';
    if (!validOwners.includes(owner)) {
      return reply.status(400).send({ error: 'Invalid owner. Must be curia, ceo, or external.' });
    }
    if (!validSources.includes(source)) {
      return reply.status(400).send({ error: 'Invalid source. Must be ceo, agent, scheduler, or coordinator.' });
    }
    if (body.priority !== undefined && (typeof body.priority !== 'number' || !Number.isInteger(body.priority) || body.priority < 0 || body.priority > 100)) {
      return reply.status(400).send({ error: 'priority must be an integer 0–100.' });
    }
    if (body.tags !== undefined && (!Array.isArray(body.tags) || (body.tags as unknown[]).some(t => typeof t !== 'string'))) {
      return reply.status(400).send({ error: 'tags must be an array of strings.' });
    }
    if (body.errorBudget !== undefined && (typeof body.errorBudget !== 'object' || body.errorBudget === null || Array.isArray(body.errorBudget))) {
      return reply.status(400).send({ error: 'errorBudget must be a JSON object.' });
    }
    if (body.errorBudget !== undefined) {
      const budgetError = validateTaskErrorBudget(body.errorBudget as Record<string, unknown>);
      if (budgetError) {
        return reply.status(400).send({ error: budgetError });
      }
    }
    if (body.progress !== undefined && (typeof body.progress !== 'object' || body.progress === null || Array.isArray(body.progress))) {
      return reply.status(400).send({ error: 'progress must be a JSON object.' });
    }

    const conversationId =
      typeof body.conversationId === 'string' && body.conversationId.trim().length > 0
        ? body.conversationId.trim()
        : null;
    if (conversationId && !isUuid(conversationId)) {
      return reply.status(400).send({ error: 'Invalid conversationId: must be a valid UUID.' });
    }

    const intentAnchor = body.intentAnchor.trim();
    const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : intentAnchor;
    const description = typeof body.description === 'string' ? body.description.trim() || null : null;
    const priority = typeof body.priority === 'number' ? body.priority : 50;
    const dueAt = typeof body.dueAt === 'string' && body.dueAt.trim() ? body.dueAt.trim() : null;
    if (dueAt !== null && isNaN(new Date(dueAt).getTime())) {
      return reply.status(400).send({ error: 'Invalid dueAt: must be a valid ISO 8601 date string.' });
    }
    const tags = Array.isArray(body.tags) ? (body.tags as string[]) : [];
    const sourceAgentId = typeof body.sourceAgentId === 'string' && body.sourceAgentId.trim()
      ? body.sourceAgentId.trim()
      : null;
    // Decision (#1882): `tasks.source_agent_id` is TEXT holding agent *names*
    // (agents/*.yaml `name`, plus system labels like `health-service`) — not UUIDs.
    // The same `isAgentName` rule is enforced at agent load time (`src/agents/agent-name.ts`
    // + `loadAgentConfig`) so the roster cannot write values this POST would refuse.
    // Do not require the name to be currently registered; historical rows and system
    // writers can outlive a rename, and this POST is not the roster gate.
    if (sourceAgentId && !isAgentName(sourceAgentId)) {
      return reply.status(400).send({
        error: `Invalid sourceAgentId: must be an agent name (${AGENT_NAME_RULE}).`,
      });
    }
    const waitingOnText = typeof body.waitingOnText === 'string' && body.waitingOnText.trim()
      ? body.waitingOnText.trim()
      : null;

    // Stamp principal lineage (#1127). The console is a principal-only surface, so a task
    // created here must carry principal originator — otherwise, when the heartbeat later wakes
    // it, the woken-task-authorization model would floor it to agent / no-bypass. This is a
    // top-level task (no parent_task_id on this path), so capOriginatorToParent is a no-op and
    // a direct stamp is correct. Lineage only — never the live-turn signal (persisted row).
    const originator = await resolveConsoleOriginator(contactService, logger);

    try {
      const inserted = await pool.query(
        `INSERT INTO tasks (
           agent_id, title, intent_anchor, description, status, owner, priority,
           due_at, source, source_agent_id, tags, waiting_on_text,
           progress, error_budget, conversation_id, originator, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15, $16::jsonb, now())
         RETURNING ${TASK_SELECT}`,
        [
          body.agentId.trim(),
          title,
          intentAnchor,
          description,
          status,
          owner,
          priority,
          dueAt,
          source,
          sourceAgentId,
          tags,
          waitingOnText,
          JSON.stringify((body.progress as Record<string, unknown> | undefined) ?? {}),
          JSON.stringify((body.errorBudget as Record<string, unknown> | undefined) ?? {}),
          conversationId,
          // Serialize as JSON string for pg JSONB — null when no principal could be resolved.
          originator ? JSON.stringify(originator) : null,
        ],
      );
      if (!inserted.rowCount) {
        logger.error('tasks: INSERT tasks returned no rows');
        return reply.status(500).send({ error: 'Failed to create task.' });
      }
      // Correlatable breadcrumb (#1127): the lineage-resolution warning (in resolveConsoleOriginator)
      // fires before the row exists, so it can't carry an id. Re-log here with the task id when
      // lineage was dropped — otherwise the consequence (this task stranded propose-only when the
      // heartbeat later wakes it) surfaces as a generic autonomy-gate block with no link back here.
      if (!originator) {
        const createdId = (inserted.rows[0] as { id?: string } | undefined)?.id;
        logger.warn(
          { taskId: createdId, channel: 'console' },
          'tasks: console task created WITHOUT principal lineage — it will be propose-only if woken (no principal contact resolved)',
        );
      }
      return reply.status(201).send({
        task: serializeTask(inserted.rows[0]! as DbTaskRow),
      });
    } catch (err) {
      logger.error({ err }, 'tasks: POST /api/tasks failed');
      return reply.status(500).send({ error: 'Failed to create task.' });
    }
  });

  app.patch('/api/tasks/:id', CONSOLE_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;
    const { id } = request.params as { id: string };
    if (!isUuid(id)) {
      return reply.status(400).send({ error: 'Invalid task id.' });
    }
    const body = request.body as {
      agentId?: unknown;
      title?: unknown;
      intentAnchor?: unknown;
      description?: unknown;
      status?: unknown;
      owner?: unknown;
      priority?: unknown;
      dueAt?: unknown;
      source?: unknown;
      tags?: unknown;
      waitingOnText?: unknown;
      progress?: unknown;
      errorBudget?: unknown;
      conversationId?: unknown;
    };

    // Wrap the entire DB interaction in one try-catch so pool errors on the
    // existence check are handled the same way as errors from the UPDATE.
    let row: DbTaskRow;
    try {
      const existing = await pool.query(
        `SELECT ${TASK_SELECT} FROM tasks WHERE id = $1`,
        [id],
      );
      if (existing.rowCount === 0) {
        return reply.status(404).send({ error: 'Task not found.' });
      }
      row = existing.rows[0]! as DbTaskRow;
    } catch (err) {
      logger.error({ err, taskId: id }, 'tasks: PATCH /api/tasks/:id existence check failed');
      return reply.status(500).send({ error: 'Failed to load task.' });
    }

    // Validate status value before checking transition rules so callers get
    // "Invalid status" rather than "terminal state" for nonsense status strings.
    if (typeof body.status === 'string' && !validTaskStatuses.includes(body.status)) {
      return reply.status(400).send({ error: 'Invalid status.' });
    }

    // Mirror the TaskRepo terminal-state guard: once a task is done or cancelled,
    // status cannot be changed via the console API either.
    const TERMINAL_STATUSES = ['done', 'cancelled'];
    if (
      TERMINAL_STATUSES.includes(row.status) &&
      typeof body.status === 'string' &&
      body.status !== row.status
    ) {
      return reply.status(400).send({
        error: `Cannot transition task from '${row.status}' — it is a terminal state.`,
      });
    }

    const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : row.agent_id;
    const title = typeof body.title === 'string' ? body.title.trim() : row.title;
    const intentAnchor = typeof body.intentAnchor === 'string' ? body.intentAnchor.trim() : row.intent_anchor;
    const description = body.description === undefined ? row.description
      : body.description === null || body.description === '' ? null
      : typeof body.description === 'string' ? body.description.trim()
      : row.description;
    const status = typeof body.status === 'string' ? body.status : row.status;
    const owner = typeof body.owner === 'string' ? body.owner : row.owner;
    const priority = typeof body.priority === 'number' ? body.priority : row.priority;
    const dueAt = body.dueAt === undefined ? row.due_at
      : body.dueAt === null || body.dueAt === '' ? null
      : typeof body.dueAt === 'string' ? body.dueAt.trim() || null
      : row.due_at;
    const source = typeof body.source === 'string' ? body.source : row.source;
    const tags = Array.isArray(body.tags) ? (body.tags as string[]) : row.tags;
    const waitingOnText = body.waitingOnText === undefined ? row.waiting_on_text
      : body.waitingOnText === null || body.waitingOnText === '' ? null
      : typeof body.waitingOnText === 'string' ? body.waitingOnText
      : row.waiting_on_text;

    if (!agentId) return reply.status(400).send({ error: 'agentId is required.' });
    if (!intentAnchor) return reply.status(400).send({ error: 'intentAnchor is required.' });
    if (!validTaskStatuses.includes(status)) return reply.status(400).send({ error: 'Invalid status.' });
    if (!validOwners.includes(owner)) return reply.status(400).send({ error: 'Invalid owner. Must be curia, ceo, or external.' });
    if (!validSources.includes(source)) return reply.status(400).send({ error: 'Invalid source. Must be ceo, agent, scheduler, or coordinator.' });
    if (!Number.isInteger(priority) || priority < 0 || priority > 100) return reply.status(400).send({ error: 'priority must be an integer 0–100.' });
    if (dueAt !== null && isNaN(new Date(dueAt).getTime())) {
      return reply.status(400).send({ error: 'Invalid dueAt: must be a valid ISO 8601 date string.' });
    }
    if (body.tags !== undefined && (!Array.isArray(body.tags) || (body.tags as unknown[]).some(t => typeof t !== 'string'))) {
      return reply.status(400).send({ error: 'tags must be an array of strings.' });
    }
    if (body.errorBudget !== undefined && (typeof body.errorBudget !== 'object' || body.errorBudget === null || Array.isArray(body.errorBudget))) {
      return reply.status(400).send({ error: 'errorBudget must be a JSON object.' });
    }
    if (body.errorBudget !== undefined) {
      const budgetError = validateTaskErrorBudget(body.errorBudget as Record<string, unknown>);
      if (budgetError) {
        return reply.status(400).send({ error: budgetError });
      }
    }
    if (body.progress !== undefined && (typeof body.progress !== 'object' || body.progress === null || Array.isArray(body.progress))) {
      return reply.status(400).send({ error: 'progress must be a JSON object.' });
    }

    const conversationId =
      typeof body.conversationId === 'string'
        ? body.conversationId.trim() || null
        : body.conversationId === null
        ? null
        : row.conversation_id;
    if (conversationId && !isUuid(conversationId)) {
      return reply.status(400).send({ error: 'Invalid conversationId: must be a valid UUID.' });
    }

    // Status transitions must go through TaskRepo: a direct UPDATE skips wake-up
    // cancellation, child reconciliation and outreach close (#2340).
    if (typeof body.status === 'string' && body.status !== row.status) {
      if (!taskRepo) {
        logger.error({ taskId: id }, 'tasks: PATCH status change requested but TaskRepo is not wired');
        return reply.status(503).send({ error: 'Task status updates are unavailable.' });
      }
      try {
        const transitioned = await taskRepo.updateTask(id, { status: body.status }, 'console');
        if (!transitioned) return reply.status(404).send({ error: 'Task not found.' });
      } catch (err) {
        if (err instanceof TaskTerminalStateError) return reply.status(400).send({ error: err.message });
        logger.error({ err, taskId: id }, 'tasks: PATCH status change via TaskRepo failed');
        return reply.status(500).send({ error: 'Failed to update task.' });
      }
      // updateTask commits the status, and its wake and outreach side effects,
      // before the column UPDATE below. If that UPDATE fails the client gets 500
      // and the status change has already landed.
    }

    try {
      const updated = await pool.query(
        `UPDATE tasks
         SET agent_id        = $2,
             title           = $3,
             intent_anchor   = $4,
             description     = $5,
             status          = $6,
             owner           = $7,
             priority        = $8,
             due_at          = $9,
             source          = $10,
             tags            = $11,
             waiting_on_text = $12,
             progress        = $13::jsonb,
             error_budget    = $14::jsonb,
             conversation_id = $15,
             updated_at      = now()
         WHERE id = $1
           AND ($6 = status OR status NOT IN ('done', 'cancelled'))
         RETURNING ${TASK_SELECT}`,
        [
          id,
          agentId,
          title,
          intentAnchor,
          description,
          status,
          owner,
          priority,
          dueAt,
          source,
          tags,
          waitingOnText,
          JSON.stringify((body.progress as Record<string, unknown> | undefined) ?? row.progress ?? {}),
          JSON.stringify((body.errorBudget as Record<string, unknown> | undefined) ?? row.error_budget ?? {}),
          conversationId,
        ],
      );
      // Zero rows updated: either a concurrent delete or a concurrent terminal transition
      // slipped in after our pre-check. Re-read to distinguish the two cases.
      if (!updated.rowCount) {
        const current = await pool.query<{ status: string }>(
          `SELECT status FROM tasks WHERE id = $1`,
          [id],
        );
        if (!current.rowCount) {
          logger.warn({ taskId: id }, 'tasks: PATCH tasks matched 0 rows — likely concurrent delete');
          return reply.status(404).send({ error: 'Task not found.' });
        }
        const currentStatus = current.rows[0]!.status;
        if (['done', 'cancelled'].includes(currentStatus) && typeof body.status === 'string' && body.status !== currentStatus) {
          return reply.status(400).send({
            error: `Cannot transition task from '${currentStatus}' — it is a terminal state.`,
          });
        }
        // Neither delete nor terminal: unexpected. Surface a 500 rather than silently dropping.
        logger.error({ taskId: id, currentStatus }, 'tasks: PATCH UPDATE matched 0 rows for non-terminal task');
        return reply.status(500).send({ error: 'Update failed unexpectedly.' });
      }
      // Re-fetch with enriched JOIN so the response includes contact name and
      // next wake-up time, keeping parity with the GET list response shape.
      const enriched = await pool.query(
        `SELECT
          t.id, t.agent_id, t.title, t.intent_anchor, t.description, t.status,
          t.owner, t.priority, t.due_at, t.source, t.source_agent_id, t.tags,
          t.waiting_on_contact_id, t.waiting_on_text, t.parent_task_id,
          t.blocked_by_task_id, t.progress, t.error_budget, t.conversation_id,
          t.created_at, t.updated_at,
          c.display_name AS waiting_on_contact_name,
          (SELECT COALESCE(sj.deferred_wake_at, sj.next_run_at) FROM scheduled_jobs sj
           WHERE sj.task_id = t.id
             AND (sj.status = 'pending' OR (sj.status = 'running' AND sj.deferred_wake_at IS NOT NULL))
           ORDER BY COALESCE(sj.deferred_wake_at, sj.next_run_at) ASC LIMIT 1) AS next_wake_at
         FROM tasks t
         LEFT JOIN contacts c ON c.id = t.waiting_on_contact_id
         WHERE t.id = $1`,
        [id],
      );
      // Guard against concurrent deletes between the UPDATE and the re-fetch.
      if (!enriched.rowCount) {
        logger.warn({ taskId: id }, 'tasks: PATCH enriched re-fetch matched 0 rows — concurrent delete');
        return reply.status(404).send({ error: 'Task not found.' });
      }
      return reply.send({
        task: serializeTask(enriched.rows[0]! as DbTaskRow),
      });
    } catch (err) {
      logger.error({ err, taskId: id }, 'tasks: PATCH /api/tasks/:id failed');
      return reply.status(500).send({ error: 'Failed to update task.' });
    }
  });

  app.delete('/api/tasks/:id', CONSOLE_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;
    const { id } = request.params as { id: string };
    if (!isUuid(id)) {
      return reply.status(400).send({ error: 'Invalid task id.' });
    }
    try {
      const deleted = await pool.query('DELETE FROM tasks WHERE id = $1', [id]);
      if (deleted.rowCount === 0) {
        return reply.status(404).send({ error: 'Task not found.' });
      }
      return reply.status(204).send();
    } catch (err) {
      logger.error({ err, taskId: id }, 'tasks: DELETE /api/tasks/:id failed');
      return reply.status(500).send({ error: 'Failed to delete task.' });
    }
  });
}
