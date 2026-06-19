import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { EventBus } from '../../../bus/bus.js';
import { createInboundMessage } from '../../../bus/events.js';
import type { Logger } from '../../../logger.js';
import type { ContactService } from '../../../contacts/contact-service.js';
import { ContactValidationError } from '../../../contacts/contact-service.js';
import type { Contact, ContactCanonicalFields, ContactKind, ContactStatus, ContactTier, TrustLevel } from '../../../contacts/types.js';
import type { EventRouter } from '../event-router.js';
import { assertSecret, compareSecrets, hashToken, type SessionStore } from '../session-auth.js';
import { markdownToHtml } from '../../../utils/markdown-to-html.js';
import { stripOutboundContextPreamble } from '../../../dispatch/outbound-context.js';

export interface KnowledgeGraphRouteOptions {
  pool: Pool;
  logger: Logger;
  webAppBootstrapSecret: string | undefined;
  // True when APP_ORIGIN is https:// — causes Set-Cookie to include the Secure flag.
  // False in local dev so cookies work on http://localhost without browser rejection.
  secureCookies: boolean;
  // Bus + EventRouter are required for the chat endpoints (POST /api/kg/chat/messages
  // and GET /api/kg/chat/stream). The chat routes dispatch inbound messages through the
  // bus and stream outbound responses back via SSE, mirroring the pattern used by the
  // existing /api/messages endpoints.
  bus: EventBus;
  eventRouter: EventRouter;
  contactService: ContactService;
  // Shared session store — created in HttpAdapter, passed to both KG and identity routes
  // so both can accept the curia_session cookie for authentication.
  sessions: SessionStore;
}

// Channel identifier used when the KG web app dispatches messages to the agent layer.
// The 'web' channel is special-cased in contact-resolver.ts to auto-resolve to the CEO —
// the bootstrap secret is CEO-only, so any authenticated web request is implicitly the CEO.
// See config/channel-trust.yaml for the channel policy.
const WEB_CHANNEL_ID = 'web';
// Sentinel sender ID for the web channel. The value is cosmetic — contact-resolver.ts
// short-circuits to the CEO contact for this channel regardless of the sender string.
const WEB_SENDER_ID = 'ceo-web-user';

interface KgNodeRow {
  id: string;
  type: string;
  label: string;
  properties: Record<string, unknown>;
  confidence: number;
  decay_class: string;
  source: string;
  created_at: string;
  last_confirmed_at: string;
  sensitivity: string;
}

interface KgEdgeRow {
  id: string;
  source_node_id: string;
  target_node_id: string;
  type: string;
  properties: Record<string, unknown>;
  confidence: number;
  decay_class: string;
  source: string;
  created_at: string;
  last_confirmed_at: string;
}

function normalizeLimit(raw: string | undefined, fallback: number, max: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.max(1, Math.min(parsed, max));
}

export async function knowledgeGraphRoutes(
  app: FastifyInstance,
  options: KnowledgeGraphRouteOptions,
): Promise<void> {
  const { pool, logger, webAppBootstrapSecret, secureCookies, bus, eventRouter, contactService, sessions } = options;
  // sessions is managed by HttpAdapter — no local Map creation needed here.

  // POST /auth — exchanges the bootstrap secret for an HttpOnly session cookie.
  // Tighter rate limit than the global default: 10 attempts per 15 minutes per IP,
  // preventing online brute-force against the secret.
  app.post('/auth', {
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    if (!webAppBootstrapSecret) {
      return reply.status(503).send({ error: 'KG web UI is disabled.' });
    }

    const body = request.body as { secret?: unknown };
    const provided = typeof body?.secret === 'string' ? body.secret : '';

    if (!compareSecrets(provided, webAppBootstrapSecret)) {
      return reply.status(401).send({ error: 'Invalid access key.' });
    }

    // Issue a 256-bit random session token. The secret itself never goes in the cookie.
    const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
    const token = randomBytes(32).toString('hex');
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

    // Write to Postgres first — if the DB write fails, the Map is never updated and the
    // cookie is never sent, so no phantom session can be created.
    // ON CONFLICT is a safety net against an astronomically unlikely 256-bit hash collision.
    try {
      await pool.query(
        `INSERT INTO sessions (token_hash, last_seen_at, expires_at)
         VALUES ($1, NOW(), $2)
         ON CONFLICT (token_hash) DO UPDATE SET expires_at = EXCLUDED.expires_at, last_seen_at = NOW()`,
        [tokenHash, expiresAt],
      );
    } catch (err) {
      logger.error({ err }, 'Failed to persist session to Postgres');
      return reply.status(503).send({ error: 'Login is temporarily unavailable. Please try again.' });
    }
    sessions.set(tokenHash, expiresAt.getTime());

    reply.setCookie('curia_session', token, {
      httpOnly: true,
      secure: secureCookies,  // true in prod (https://), false for http://localhost
      sameSite: 'strict',
      path: '/',
      maxAge: SESSION_TTL_MS / 1000,
    });

    return reply.status(200).send({ ok: true });
  });

  // Rate limit for KG API endpoints: 60/min per IP allows interactive browsing
  // while blocking DoS-level query floods against the database.
  const KG_RATE = { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } };

  app.get('/api/kg/nodes', KG_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;

    const query = request.query as {
      query?: string;
      type?: string;
      limit?: string;
    };

    const limit = normalizeLimit(query.limit, 50, 250);
    const searchQuery = query.query?.trim();
    const typeFilter = query.type?.trim();

    const result = await pool.query<KgNodeRow>(
      `SELECT id, type, label, properties, confidence, decay_class, source, created_at, last_confirmed_at, sensitivity
       FROM kg_nodes
       WHERE ($1::text IS NULL OR type = $1)
         AND (
           $2::text IS NULL
           OR label ILIKE '%' || $2 || '%'
           OR properties::text ILIKE '%' || $2 || '%'
         )
       ORDER BY last_confirmed_at DESC
       LIMIT $3`,
      [typeFilter || null, searchQuery || null, limit],
    );

    return reply.send({
      nodes: result.rows.map((row) => ({
        id: row.id,
        type: row.type,
        label: row.label,
        properties: row.properties,
        confidence: row.confidence,
        decayClass: row.decay_class,
        source: row.source,
        createdAt: row.created_at,
        lastConfirmedAt: row.last_confirmed_at,
        sensitivity: row.sensitivity,
      })),
    });
  });

  app.get('/api/kg/graph', KG_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;

    const query = request.query as {
      node_id?: string;
      depth?: string;
      limit?: string;
    };

    const nodeId = query.node_id?.trim();
    const depth = normalizeLimit(query.depth, 2, 4);
    const limit = normalizeLimit(query.limit, 100, 300);

    // Reject malformed UUIDs before they reach SQL — Postgres would throw a cast error
    // and surface as a 500 rather than a useful 400 for the caller.
    if (nodeId && !UUID_RE.test(nodeId)) {
      return reply.status(400).send({ error: 'Invalid node_id: must be a valid UUID.' });
    }

    const nodeResult = nodeId
      ? await pool.query<KgNodeRow>(
          // visited tracks the set of node IDs already expanded, preventing the same
          // node from being re-expanded when reached at a different depth (which UNION
          // alone can't prevent because depth is part of each row's identity).
          `WITH RECURSIVE traversal AS (
             SELECT id, 0 AS depth, ARRAY[id] AS visited
             FROM kg_nodes
             WHERE id = $1::uuid
             UNION ALL
             SELECT
               CASE WHEN e.source_node_id = t.id THEN e.target_node_id ELSE e.source_node_id END AS id,
               t.depth + 1,
               t.visited || CASE WHEN e.source_node_id = t.id THEN e.target_node_id ELSE e.source_node_id END
             FROM traversal t
             JOIN kg_edges e ON e.source_node_id = t.id OR e.target_node_id = t.id
             WHERE t.depth < $2
               AND NOT (CASE WHEN e.source_node_id = t.id THEN e.target_node_id ELSE e.source_node_id END = ANY(t.visited))
           )
           SELECT DISTINCT n.id, n.type, n.label, n.properties, n.confidence, n.decay_class, n.source, n.created_at, n.last_confirmed_at, n.sensitivity
           FROM traversal t
           JOIN kg_nodes n ON n.id = t.id
           ORDER BY n.last_confirmed_at DESC
           LIMIT $3`,
          [nodeId, depth, limit],
        )
      : await pool.query<KgNodeRow>(
          `SELECT id, type, label, properties, confidence, decay_class, source, created_at, last_confirmed_at, sensitivity
           FROM kg_nodes
           ORDER BY last_confirmed_at DESC
           LIMIT $1`,
          [limit],
        );

    if (nodeResult.rows.length === 0) {
      return reply.send({ nodes: [], edges: [] });
    }

    const nodeIds = nodeResult.rows.map((row) => row.id);
    const edgeResult = await pool.query<KgEdgeRow>(
      `SELECT id, source_node_id, target_node_id, type, properties, confidence, decay_class, source, created_at, last_confirmed_at
       FROM kg_edges
       WHERE source_node_id = ANY($1::uuid[])
         AND target_node_id = ANY($1::uuid[])
       ORDER BY last_confirmed_at DESC
       LIMIT 1000`,
      [nodeIds],
    );

    logger.debug({ nodes: nodeResult.rowCount, edges: edgeResult.rowCount }, 'kg: graph query served');

    return reply.send({
      nodes: nodeResult.rows.map((row) => ({
        id: row.id,
        type: row.type,
        label: row.label,
        properties: row.properties,
        confidence: row.confidence,
        decayClass: row.decay_class,
        source: row.source,
        createdAt: row.created_at,
        lastConfirmedAt: row.last_confirmed_at,
        sensitivity: row.sensitivity,
      })),
      edges: edgeResult.rows.map((row) => ({
        id: row.id,
        sourceNodeId: row.source_node_id,
        targetNodeId: row.target_node_id,
        type: row.type,
        confidence: row.confidence,
        decayClass: row.decay_class,
        source: row.source,
        createdAt: row.created_at,
        lastConfirmedAt: row.last_confirmed_at,
      })),
    });
  });

  const validContactStatuses: ContactStatus[] = ['confirmed', 'provisional', 'blocked'];
  // tier/kind selectable via the API — 'principal' and kind∈{principal,agent} are structural-only.
  const validContactTiers: ContactTier[] = ['blocked', 'unknown', 'known', 'trusted'];
  const validContactKinds: ContactKind[] = ['person', 'organization', 'automated'];
  const validTaskStatuses = [
    // Legacy values used by the scheduler before task skills shipped
    'active', 'pending', 'paused', 'completed', 'failed',
    // Task-lifecycle values introduced by migration 049
    'open', 'in_progress', 'blocked', 'waiting', 'done', 'cancelled',
  ];
  // Reused across contacts endpoints — Postgres UUID columns throw cast errors on bad input
  // so we reject at the API boundary with a 400 instead.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  const TASK_ENRICHED_QUERY = `
    SELECT
      t.id, t.agent_id, t.title, t.intent_anchor, t.description, t.status,
      t.owner, t.priority, t.due_at, t.source, t.source_agent_id, t.tags,
      t.waiting_on_contact_id, t.waiting_on_text, t.parent_task_id,
      t.blocked_by_task_id, t.progress, t.error_budget, t.conversation_id,
      t.created_at, t.updated_at,
      c.display_name AS waiting_on_contact_name,
      (SELECT sj.next_run_at FROM scheduled_jobs sj
       WHERE sj.task_id = t.id AND sj.status = 'pending'
       ORDER BY sj.next_run_at ASC LIMIT 1) AS next_wake_at
    FROM tasks t
    LEFT JOIN contacts c ON c.id = t.waiting_on_contact_id
    ORDER BY t.updated_at DESC
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

  app.get('/api/kg/tasks', KG_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;
    try {
      const result = await pool.query(TASK_ENRICHED_QUERY);
      return reply.send({
        tasks: result.rows.map((row) => serializeTask(row as DbTaskRow)),
      });
    } catch (err) {
      logger.error({ err }, 'kg: GET /api/kg/tasks failed');
      return reply.status(500).send({ error: 'Failed to load tasks.' });
    }
  });

  app.post('/api/kg/tasks', KG_RATE, async (request, reply) => {
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
    const source = typeof body.source === 'string' ? body.source : 'agent';
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
    if (body.progress !== undefined && (typeof body.progress !== 'object' || body.progress === null || Array.isArray(body.progress))) {
      return reply.status(400).send({ error: 'progress must be a JSON object.' });
    }

    const conversationId =
      typeof body.conversationId === 'string' && body.conversationId.trim().length > 0
        ? body.conversationId.trim()
        : null;
    if (conversationId && !UUID_RE.test(conversationId)) {
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
    if (sourceAgentId && !UUID_RE.test(sourceAgentId)) {
      return reply.status(400).send({ error: 'Invalid sourceAgentId: must be a valid UUID.' });
    }
    const waitingOnText = typeof body.waitingOnText === 'string' && body.waitingOnText.trim()
      ? body.waitingOnText.trim()
      : null;

    try {
      const inserted = await pool.query(
        `INSERT INTO tasks (
           agent_id, title, intent_anchor, description, status, owner, priority,
           due_at, source, source_agent_id, tags, waiting_on_text,
           progress, error_budget, conversation_id, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15, now())
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
        ],
      );
      if (!inserted.rowCount) {
        logger.error('kg: INSERT tasks returned no rows');
        return reply.status(500).send({ error: 'Failed to create task.' });
      }
      return reply.status(201).send({
        task: serializeTask(inserted.rows[0]! as DbTaskRow),
      });
    } catch (err) {
      logger.error({ err }, 'kg: POST /api/kg/tasks failed');
      return reply.status(500).send({ error: 'Failed to create task.' });
    }
  });

  app.patch('/api/kg/tasks/:id', KG_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;
    const { id } = request.params as { id: string };
    if (!UUID_RE.test(id)) {
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
      logger.error({ err, taskId: id }, 'kg: PATCH /api/kg/tasks/:id existence check failed');
      return reply.status(500).send({ error: 'Failed to load task.' });
    }

    // Validate status value before checking transition rules so callers get
    // "Invalid status" rather than "terminal state" for nonsense status strings.
    if (typeof body.status === 'string' && !validTaskStatuses.includes(body.status)) {
      return reply.status(400).send({ error: 'Invalid status.' });
    }

    // Mirror the TaskRepo terminal-state guard: once a task is done or cancelled,
    // status cannot be changed via the console API either.
    const TERMINAL_STATUSES_KG = ['done', 'cancelled'];
    if (
      TERMINAL_STATUSES_KG.includes(row.status) &&
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
    if (body.progress !== undefined && (typeof body.progress !== 'object' || body.progress === null || Array.isArray(body.progress))) {
      return reply.status(400).send({ error: 'progress must be a JSON object.' });
    }

    const conversationId =
      typeof body.conversationId === 'string'
        ? body.conversationId.trim() || null
        : body.conversationId === null
        ? null
        : row.conversation_id;
    if (conversationId && !UUID_RE.test(conversationId)) {
      return reply.status(400).send({ error: 'Invalid conversationId: must be a valid UUID.' });
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
          logger.warn({ taskId: id }, 'kg: PATCH tasks matched 0 rows — likely concurrent delete');
          return reply.status(404).send({ error: 'Task not found.' });
        }
        const currentStatus = current.rows[0]!.status;
        if (['done', 'cancelled'].includes(currentStatus) && typeof body.status === 'string' && body.status !== currentStatus) {
          return reply.status(400).send({
            error: `Cannot transition task from '${currentStatus}' — it is a terminal state.`,
          });
        }
        // Neither delete nor terminal: unexpected. Surface a 500 rather than silently dropping.
        logger.error({ taskId: id, currentStatus }, 'kg: PATCH UPDATE matched 0 rows for non-terminal task');
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
          (SELECT sj.next_run_at FROM scheduled_jobs sj
           WHERE sj.task_id = t.id AND sj.status = 'pending'
           ORDER BY sj.next_run_at ASC LIMIT 1) AS next_wake_at
         FROM tasks t
         LEFT JOIN contacts c ON c.id = t.waiting_on_contact_id
         WHERE t.id = $1`,
        [id],
      );
      // Guard against concurrent deletes between the UPDATE and the re-fetch.
      if (!enriched.rowCount) {
        logger.warn({ taskId: id }, 'kg: PATCH enriched re-fetch matched 0 rows — concurrent delete');
        return reply.status(404).send({ error: 'Task not found.' });
      }
      return reply.send({
        task: serializeTask(enriched.rows[0]! as DbTaskRow),
      });
    } catch (err) {
      logger.error({ err, taskId: id }, 'kg: PATCH /api/kg/tasks/:id failed');
      return reply.status(500).send({ error: 'Failed to update task.' });
    }
  });

  app.delete('/api/kg/tasks/:id', KG_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;
    const { id } = request.params as { id: string };
    if (!UUID_RE.test(id)) {
      return reply.status(400).send({ error: 'Invalid task id.' });
    }
    try {
      const deleted = await pool.query('DELETE FROM tasks WHERE id = $1', [id]);
      if (deleted.rowCount === 0) {
        return reply.status(404).send({ error: 'Task not found.' });
      }
      return reply.status(204).send();
    } catch (err) {
      logger.error({ err, taskId: id }, 'kg: DELETE /api/kg/tasks/:id failed');
      return reply.status(500).send({ error: 'Failed to delete task.' });
    }
  });

  // Serialize a Contact object to the HTTP response shape.
  // Returns all canonical fields so the Console UI can display them
  // without a separate detail fetch.
  function serializeContact(c: Contact) {
    return {
      id: c.id,
      kgNodeId: c.kgNodeId,
      displayName: c.displayName,
      role: c.role,
      // Legacy columns — kept until #955 drops them.
      status: c.status,
      trustLevel: c.trustLevel,
      // New capability axis (issue #945).
      tier: c.tier,
      kind: c.kind,
      systemRole: c.systemRole,
      notes: c.notes,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
      // Canonical fields (migration 048)
      preferredName: c.preferredName,
      title: c.title,
      organization: c.organization,
      primaryEmail: c.primaryEmail,
      primaryPhone: c.primaryPhone,
      timezone: c.timezone,
      locale: c.locale,
      location: c.location,
      pronouns: c.pronouns,
      linkedinUrl: c.linkedinUrl,
      bio: c.bio,
      birthday: c.birthday,
    };
  }

  // Validate canonical fields from a POST/PATCH body.
  // Returns an error string if invalid, or null if all checks pass.
  // `fields` entries are trimmed and empty-string-coerced to null.
  function extractAndValidateCanonicalFields(body: Record<string, unknown>): {
    error: string | null;
    fields: ContactCanonicalFields;
  } {
    const str = (v: unknown): string | null =>
      typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;

    const fields: ContactCanonicalFields = {};

    // Reject non-string, non-nullish values — the str() helper would silently coerce
    // them to null, which would erase existing data on PATCH.
    const CANONICAL_STRING_KEYS = [
      'preferredName', 'title', 'organization', 'primaryPhone', 'timezone', 'locale',
      'location', 'pronouns', 'birthday', 'linkedinUrl', 'bio', 'primaryEmail',
    ] as const;
    const badKey = CANONICAL_STRING_KEYS.find(
      k => k in body && body[k] !== null && body[k] !== undefined && typeof body[k] !== 'string',
    );
    if (badKey) {
      return { error: `${badKey} must be a string or null.`, fields };
    }

    if ('preferredName' in body) fields.preferredName = str(body.preferredName);
    if ('title' in body) fields.title = str(body.title);
    if ('organization' in body) fields.organization = str(body.organization);
    if ('primaryPhone' in body) fields.primaryPhone = str(body.primaryPhone);
    if ('timezone' in body) fields.timezone = str(body.timezone);
    if ('locale' in body) fields.locale = str(body.locale);
    if ('location' in body) fields.location = str(body.location);
    if ('pronouns' in body) fields.pronouns = str(body.pronouns);
    if ('birthday' in body) fields.birthday = str(body.birthday);
    if ('linkedinUrl' in body) fields.linkedinUrl = str(body.linkedinUrl);
    if ('bio' in body) fields.bio = str(body.bio);
    if ('primaryEmail' in body) fields.primaryEmail = str(body.primaryEmail);

    // Format validation
    // Domain labels exclude '.' so the repeated atom and the literal '.' don't
    // overlap — this keeps matching linear and avoids the polynomial-time
    // backtracking (ReDoS) the previous `[^@\s]+\.[^@\s]+` form allowed on
    // attacker-controlled input. See CodeQL alert js/polynomial-redos (#96).
    if (fields.primaryEmail != null && !/^[^@\s]+@[^@\s.]+(?:\.[^@\s.]+)+$/.test(fields.primaryEmail)) {
      return { error: 'Invalid primaryEmail format.', fields };
    }
    if (fields.linkedinUrl != null && !/^https?:\/\/(www\.)?linkedin\.com\//.test(fields.linkedinUrl)) {
      return { error: 'linkedinUrl must be a linkedin.com URL (e.g. https://linkedin.com/in/…).', fields };
    }
    if (fields.primaryPhone != null && !/^\+[1-9]\d{6,14}$/.test(fields.primaryPhone)) {
      return { error: 'primaryPhone must be in E.164 format (e.g. +15551234567).', fields };
    }
    if (fields.locale != null && !/^[a-z]{2,3}(-[A-Z]{2,4})?$/.test(fields.locale)) {
      return { error: 'locale must be a BCP 47 code (e.g. en-US, fr, zh-Hans).', fields };
    }
    if (fields.bio != null && fields.bio.length > 500) {
      return { error: 'bio must be 500 characters or fewer.', fields };
    }
    if (fields.birthday != null &&
        !/^\d{4}-\d{2}-\d{2}$/.test(fields.birthday) &&
        !/^--\d{2}-\d{2}$/.test(fields.birthday)) {
      return { error: 'birthday must be YYYY-MM-DD or --MM-DD.', fields };
    }

    return { error: null, fields };
  }

  app.get('/api/kg/contacts', KG_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;
    try {
      const contacts = await contactService.listContacts();
      return reply.send({
        contacts: contacts.map(serializeContact),
      });
    } catch (err) {
      logger.error({ err }, 'GET /api/kg/contacts failed');
      return reply.status(500).send({ error: 'Failed to load contacts' });
    }
  });

  app.post('/api/kg/contacts', KG_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;
    const body = request.body as {
      displayName?: unknown;
      role?: unknown;
      status?: unknown;
      trustLevel?: unknown;
      tier?: unknown;
      kind?: unknown;
      notes?: unknown;
      kgNodeId?: unknown;
    };

    if (typeof body.displayName !== 'string' || body.displayName.trim().length === 0) {
      return reply.status(400).send({ error: 'displayName is required.' });
    }
    const status = typeof body.status === 'string' ? body.status : 'confirmed';
    if (!validContactStatuses.includes(status as ContactStatus)) {
      return reply.status(400).send({ error: 'Invalid status.' });
    }
    const validTrustLevelsCreate = ['ceo', 'high', 'medium', 'low'];
    if (body.trustLevel !== undefined && body.trustLevel !== null &&
        (typeof body.trustLevel !== 'string' || !validTrustLevelsCreate.includes(body.trustLevel))) {
      return reply.status(400).send({ error: 'Invalid trustLevel.' });
    }
    if (body.tier !== undefined &&
        (typeof body.tier !== 'string' || !validContactTiers.includes(body.tier as ContactTier))) {
      return reply.status(400).send({ error: `Invalid tier. Must be one of: ${validContactTiers.join(', ')}.` });
    }
    if (body.kind !== undefined &&
        (typeof body.kind !== 'string' || !validContactKinds.includes(body.kind as ContactKind))) {
      return reply.status(400).send({ error: `Invalid kind. Must be one of: ${validContactKinds.join(', ')}.` });
    }

    const kgNodeId =
      typeof body.kgNodeId === 'string' && body.kgNodeId.trim().length > 0
        ? body.kgNodeId.trim()
        : undefined;
    if (kgNodeId && !UUID_RE.test(kgNodeId)) {
      return reply.status(400).send({ error: 'Invalid kgNodeId: must be a valid UUID.' });
    }

    const { error: canonicalError, fields: canonicalFields } = extractAndValidateCanonicalFields(body as Record<string, unknown>);
    if (canonicalError) {
      return reply.status(400).send({ error: canonicalError });
    }

    const created = await contactService.createContact({
      displayName: body.displayName,
      role: typeof body.role === 'string' && body.role.trim().length > 0 ? body.role : undefined,
      status: status as ContactStatus,
      notes: typeof body.notes === 'string' && body.notes.trim().length > 0 ? body.notes : undefined,
      kgNodeId,
      source: 'kg_web_ui',
      ...canonicalFields,
    });

    // Apply trustLevel if provided — createContact always initialises it to null.
    if (typeof body.trustLevel === 'string') {
      await contactService.setTrustLevel(created.id, body.trustLevel as TrustLevel);
    }
    // Apply tier/kind overrides if provided — these take precedence over status/trustLevel-derived values.
    if (typeof body.tier === 'string') {
      await contactService.setTier(created.id, body.tier as ContactTier);
    }
    if (typeof body.kind === 'string') {
      await contactService.setKind(created.id, body.kind as ContactKind);
    }

    const freshCreated = await contactService.getContact(created.id);
    if (!freshCreated) {
      // Should never happen — contact was just created — but guard rather than return stale data.
      logger.error({ contactId: created.id }, 'POST /api/kg/contacts: contact not found after creation');
      return reply.status(500).send({ error: 'Contact created but could not be retrieved.' });
    }
    return reply.status(201).send({
      contact: serializeContact(freshCreated),
    });
  });

  app.patch('/api/kg/contacts/:id', KG_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;
    const { id } = request.params as { id: string };
    const body = request.body as {
      displayName?: unknown;
      role?: unknown;
      status?: unknown;
      trustLevel?: unknown;
      tier?: unknown;
      kind?: unknown;
      notes?: unknown;
      kgNodeId?: unknown;
    };
    const contact = await contactService.getContact(id);
    if (!contact) {
      return reply.status(404).send({ error: 'Contact not found.' });
    }

    // Validate all inputs before any mutations to avoid partial writes on bad input.
    if (typeof body.status === 'string' && !validContactStatuses.includes(body.status as ContactStatus)) {
      return reply.status(400).send({ error: 'Invalid status.' });
    }
    const validTrustLevels = ['ceo', 'high', 'medium', 'low'];
    if ('trustLevel' in body && body.trustLevel !== null &&
        (typeof body.trustLevel !== 'string' || !validTrustLevels.includes(body.trustLevel))) {
      return reply.status(400).send({ error: 'Invalid trustLevel.' });
    }
    // Validate tier — rejects 'principal' (structural, derived from system_role).
    if ('tier' in body) {
      if (typeof body.tier !== 'string' || !validContactTiers.includes(body.tier as ContactTier)) {
        return reply.status(400).send({ error: `Invalid tier. Must be one of: ${validContactTiers.join(', ')}.` });
      }
      // Principal contacts cannot be demoted or re-typed via the API.
      if (contact.systemRole === 'principal') {
        return reply.status(400).send({ error: 'The principal contact\'s tier cannot be changed via the API.' });
      }
    }
    // Validate kind — rejects 'principal' and 'agent' (structural).
    if ('kind' in body) {
      if (typeof body.kind !== 'string' || !validContactKinds.includes(body.kind as ContactKind)) {
        return reply.status(400).send({ error: `Invalid kind. Must be one of: ${validContactKinds.join(', ')}.` });
      }
      if (contact.systemRole === 'principal' || contact.systemRole === 'agent') {
        return reply.status(400).send({ error: 'The kind of a system contact (principal or agent) cannot be changed via the API.' });
      }
    }
    // Trim once; collapse whitespace-only strings to null so they don't reach the DB as invalid UUIDs.
    const normalizedKgNodeId: string | null | undefined =
      typeof body.kgNodeId === 'string'
        ? (body.kgNodeId.trim() || null)
        : body.kgNodeId === null
        ? null
        : undefined;
    if (typeof normalizedKgNodeId === 'string' && !UUID_RE.test(normalizedKgNodeId)) {
      return reply.status(400).send({ error: 'Invalid kgNodeId: must be a valid UUID.' });
    }

    const { error: canonicalError, fields: canonicalFields } = extractAndValidateCanonicalFields(body as Record<string, unknown>);
    if (canonicalError) {
      return reply.status(400).send({ error: canonicalError });
    }

    // Validate primaryEmail against CCI before any mutations so a bad value can never
    // produce partial writes (other fields committed, response still 400).
    if (canonicalFields.primaryEmail != null) {
      try {
        await contactService.validatePrimaryEmail(id, canonicalFields.primaryEmail);
      } catch (err) {
        if (err instanceof ContactValidationError) {
          return reply.status(400).send({ error: err.message });
        }
        throw err;
      }
    }

    // Build the complete updated contact in memory from the pre-validation snapshot.
    // All per-field setters read the contact non-transactionally, so calling them in
    // sequence causes each write to clobber earlier changes with stale data. Assembling
    // the full pending object here and writing once avoids that race.
    let pending: Contact = { ...contact, updatedAt: new Date() };

    if (typeof body.displayName === 'string' && body.displayName.trim().length > 0) {
      pending = { ...pending, displayName: body.displayName.trim() };
    }
    if (typeof body.role === 'string') {
      pending = { ...pending, role: body.role };
    } else if (body.role === null) {
      pending = { ...pending, role: null };
    }
    if (typeof body.tier === 'string') {
      pending = { ...pending, tier: body.tier as ContactTier };
    }
    if (typeof body.kind === 'string') {
      pending = { ...pending, kind: body.kind as ContactKind };
    }
    if (body.notes !== undefined) {
      pending = { ...pending, notes: typeof body.notes === 'string' ? body.notes : null };
    }
    if (normalizedKgNodeId !== undefined) {
      pending = { ...pending, kgNodeId: normalizedKgNodeId };
    }
    const CANONICAL_KEYS: Array<keyof typeof canonicalFields> = [
      'preferredName', 'title', 'organization', 'primaryEmail', 'primaryPhone',
      'timezone', 'locale', 'location', 'pronouns', 'linkedinUrl', 'bio', 'birthday',
    ];
    const hasCanonicalFields = CANONICAL_KEYS.some(k => k in (body as Record<string, unknown>));
    if (hasCanonicalFields) {
      const definedFields = Object.fromEntries(
        Object.entries(canonicalFields).filter(([, value]) => value !== undefined),
      ) as ContactCanonicalFields;
      if (definedFields.primaryEmail != null) {
        definedFields.primaryEmail = definedFields.primaryEmail.toLowerCase();
      }
      pending = { ...pending, ...definedFields };
    }

    // Legacy setStatus / setTrustLevel are not transaction-aware (retired in #955).
    // Run them before the transaction so a legacy-field failure is surfaced cleanly.
    if (typeof body.status === 'string') {
      await contactService.setStatus(id, body.status as ContactStatus);
    }
    if ('trustLevel' in body) {
      await contactService.setTrustLevel(id, (body.trustLevel as TrustLevel | null));
    }

    // All remaining mutations are wrapped in a single DB transaction for atomicity.
    // saveContact applies display-name sanitization and writes all fields in one UPDATE.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await contactService.saveContact(pending, client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      if (err instanceof ContactValidationError) {
        return reply.status(400).send({ error: err.message });
      }
      request.log.error({ err }, 'contacts: PATCH mutation failed');
      return reply.status(500).send({ error: 'An error occurred while updating the contact.' });
    } finally {
      client.release();
    }

    const updated = await contactService.getContact(id);
    if (!updated) {
      return reply.status(404).send({ error: 'Contact not found after update.' });
    }
    return reply.send({
      contact: serializeContact(updated),
    });
  });

  app.delete('/api/kg/contacts/:id', KG_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;
    const { id } = request.params as { id: string };
    const contact = await contactService.getContact(id);
    if (!contact) {
      return reply.status(404).send({ error: 'Contact not found.' });
    }
    await pool.query('DELETE FROM contacts WHERE id = $1', [id]);
    return reply.status(204).send();
  });

  // ── Chat endpoints ──────────────────────────────────────────────────────
  //
  // The chat endpoints let the KG web app send messages to the agent layer
  // and stream responses back. They mirror the pattern of src/channels/http/routes/messages.ts
  // (POST /api/messages + GET /api/messages/stream) but use the 'web' channel so
  // contact-resolver auto-attributes the sender to the CEO (the bootstrap secret is CEO-only).
  //
  // Auth: both routes enforce the same assertSecret guard as the KG read APIs — they accept
  // either a valid curia_session cookie (browser flow) or x-web-bootstrap-secret header
  // (programmatic flow, e.g. tests and scripts).

  /**
   * POST /api/kg/chat/messages — publish a chat message and ack immediately.
   *
   * Body: { message: string, conversationId?: string }
   * Response: 202 { conversationId }
   *
   * Ack-and-stream (#985): the handler publishes the inbound message and returns
   * 202 without waiting for the agent's reply. The final reply and intermediate
   * progress (skill.invoke / skill.result) arrive over GET /api/kg/chat/stream,
   * which is the source of truth for the assistant turn. This removes the former
   * synchronous 120s wait that 504'd on long tasks (browser automation, delegation
   * chains, research).
   */
  app.post('/api/kg/chat/messages', KG_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;

    const body = request.body as { message?: unknown; conversationId?: unknown };
    if (typeof body?.message !== 'string' || body.message.trim().length === 0) {
      return reply.status(400).send({ error: 'Missing required field: message (non-empty string)' });
    }

    const conversationId =
      typeof body.conversationId === 'string' && body.conversationId.length > 0
        ? body.conversationId
        : `kg-web-${randomUUID()}`;

    try {
      await bus.publish('channel', createInboundMessage({
        conversationId,
        channelId: WEB_CHANNEL_ID,
        senderId: WEB_SENDER_ID,
        content: body.message,
        // Tag with structural channel trust level — session-cookie auth earns medium trust,
        // same as bearer token auth on the API channel. Required for messageTrustScore computation.
        metadata: { trustLevel: 'medium' },
      }));
    } catch (publishErr) {
      // Log the real error server-side (full context) but return a fixed,
      // client-safe message — don't echo internal bus/implementation detail back.
      logger.error({ err: publishErr, conversationId }, 'KG chat message publish failed');
      return reply.status(500).send({ error: 'Failed to publish chat message.' });
    }

    // Ack: the reply is delivered over the SSE stream, not this response.
    return reply.status(202).send({ conversationId });
  });

  /**
   * GET /api/kg/chat/stream — SSE stream of agent events for the KG web app.
   *
   * Streams outbound.message, skill.invoke, and skill.result events from the EventRouter,
   * optionally filtered by ?conversationId=xxx. Mirrors GET /api/messages/stream.
   */
  app.get('/api/kg/chat/stream', KG_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;

    const query = request.query as { conversationId?: string };

    // Hand the raw socket over to us — Fastify won't send a default response after the
    // handler returns, which is what we want for a long-lived SSE stream.
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      // Nginx/ALB/Cloudflare buffer SSE by default — this header disables that.
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(':connected\n\n');

    const cleanup = eventRouter.addSseClient({
      res: reply.raw,
      conversationId: query.conversationId,
    });

    // 30s heartbeat keeps intermediary proxies from closing the connection on idle.
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(':ping\n\n');
      } catch (err) {
        // Write failed — client likely disconnected without a clean TCP close.
        // Clear the interval and explicitly remove the SSE client to prevent a leak
        // in the case where the 'close' event on request.raw doesn't fire.
        logger.debug({ err, conversationId: query.conversationId }, 'KG chat SSE heartbeat write failed — removing client');
        clearInterval(heartbeat);
        cleanup();
      }
    }, 30_000);

    request.raw.on('close', () => {
      clearInterval(heartbeat);
      cleanup();
    });
  });

  /**
   * GET /api/kg/chat/history — fetch paginated chat history from working_memory.
   *
   * Query params:
   *   - conversationId: string (required)
   *   - before: string (optional ISO timestamp — returns messages older than this cursor)
   *   - limit: number (optional, default 25, max 50)
   *
   * Returns messages in chronological order (oldest first) so the client can
   * prepend them to the thread. Fetches one extra row to determine hasMore.
   *
   * Only user/assistant turns are returned — system turns (synthetic summaries
   * inserted by the summarisation pass) are excluded since they are internal
   * artifacts not intended for display.
   */
  app.get('/api/kg/chat/history', KG_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;

    const query = request.query as {
      conversationId?: string;
      before?: string;
      limit?: string;
    };

    if (typeof query.conversationId !== 'string' || query.conversationId.trim().length === 0) {
      return reply.status(400).send({ error: 'Missing required query param: conversationId' });
    }
    const conversationId = query.conversationId.trim();

    const rawLimit = parseInt(query.limit ?? '25', 10);
    const limit = isNaN(rawLimit) || rawLimit < 1 ? 25 : Math.min(rawLimit, 50);

    // Validate the before cursor: must be a parseable ISO date if provided.
    let beforeDate: Date | undefined;
    if (query.before !== undefined && query.before.trim().length > 0) {
      beforeDate = new Date(query.before);
      if (isNaN(beforeDate.getTime())) {
        return reply.status(400).send({ error: 'Invalid before param: must be an ISO timestamp' });
      }
    }

    interface HistoryRow {
      id: string;
      role: string;
      content: string;
      created_at: Date;
    }

    try {
      // Fetch limit+1 rows so we can tell if there are more pages without a COUNT query.
      // Rows arrive newest-first; we reverse after slicing to serve them chronologically.
      // The $2::timestamptz IS NULL check makes the before-cursor optional in a single query.
      const result = await pool.query<HistoryRow>(
        `SELECT id, role, content, created_at
         FROM working_memory
         WHERE conversation_id = $1
           AND archived = false
           AND role IN ('user', 'assistant')
           AND ($2::timestamptz IS NULL OR created_at < $2)
         ORDER BY created_at DESC
         LIMIT $3`,
        [conversationId, beforeDate?.toISOString() ?? null, limit + 1],
      );

      const hasMore = result.rows.length > limit;
      // Take at most `limit` rows, then restore chronological order.
      const rows = result.rows.slice(0, limit).reverse();

      const messages = rows.map((row) => {
        // Per-row try/catch so one bad message doesn't fail the whole page.
        let html: string | null = null;
        // Strip dispatcher-injected outbound context preambles from user messages
        // before serving them — the preamble is coordinator-internal and looks
        // confusing inside the user's chat bubble.
        const content = row.role === 'user'
          ? stripOutboundContextPreamble(row.content)
          : row.content;
        if (row.role === 'assistant') {
          try {
            html = markdownToHtml(content);
          } catch (convErr) {
            logger.warn({ err: convErr, messageId: row.id }, 'markdownToHtml failed for history row; falling back to plain text');
          }
        }
        return {
          id: row.id,
          role: row.role as 'user' | 'assistant',
          content,
          html,
          timestamp: row.created_at.toISOString(),
        };
      });

      return reply.send({ messages, hasMore });
    } catch (err) {
      logger.error({ err, conversationId }, 'KG chat history fetch failed');
      return reply.status(500).send({ error: 'Failed to fetch chat history' });
    }
  });
}
