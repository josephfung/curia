import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { EventBus } from '../../../bus/bus.js';
import { createInboundMessage } from '../../../bus/events.js';
import type { Logger } from '../../../logger.js';
import type { ContactService } from '../../../contacts/contact-service.js';
import type { ContactStatus, TrustLevel } from '../../../contacts/types.js';
import { MessageRejectedError, type EventRouter } from '../event-router.js';
import { assertSecret, compareSecrets, hashToken, type SessionStore } from '../session-auth.js';
import { markdownToHtml } from '../../../utils/markdown-to-html.js';

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

// How long the chat POST waits for an agent response before timing out.
// Mirrors RESPONSE_TIMEOUT_MS in src/channels/http/routes/messages.ts — keep in sync.
const CHAT_RESPONSE_TIMEOUT_MS = 120_000;

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
  const validTaskStatuses = ['active', 'pending', 'paused', 'completed', 'failed', 'cancelled'];
  // Reused across contacts endpoints — Postgres UUID columns throw cast errors on bad input
  // so we reject at the API boundary with a 400 instead.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  function serializeTask(row: {
    id: string;
    agent_id: string;
    intent_anchor: string;
    status: string;
    progress: Record<string, unknown> | null;
    error_budget: Record<string, unknown> | null;
    conversation_id: string | null;
    scheduled_job_id: string | null;
    created_at: string;
    updated_at: string;
  }) {
    return {
      id: row.id,
      agentId: row.agent_id,
      intentAnchor: row.intent_anchor,
      status: row.status,
      progress: row.progress ?? {},
      errorBudget: row.error_budget ?? {},
      conversationId: row.conversation_id,
      scheduledJobId: row.scheduled_job_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  app.get('/api/kg/tasks', KG_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;
    const result = await pool.query(
      `SELECT id, agent_id, intent_anchor, status, progress, error_budget, conversation_id, scheduled_job_id, created_at, updated_at
       FROM agent_tasks
       ORDER BY updated_at DESC
       LIMIT 500`,
    );
    return reply.send({
      tasks: result.rows.map((row) =>
        serializeTask(row as {
          id: string;
          agent_id: string;
          intent_anchor: string;
          status: string;
          progress: Record<string, unknown> | null;
          error_budget: Record<string, unknown> | null;
          conversation_id: string | null;
          scheduled_job_id: string | null;
          created_at: string;
          updated_at: string;
        }),
      ),
    });
  });

  app.post('/api/kg/tasks', KG_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;
    const body = request.body as {
      agentId?: unknown;
      intentAnchor?: unknown;
      status?: unknown;
      progress?: unknown;
      errorBudget?: unknown;
      conversationId?: unknown;
      scheduledJobId?: unknown;
    };
    if (typeof body.agentId !== 'string' || body.agentId.trim().length === 0) {
      return reply.status(400).send({ error: 'agentId is required.' });
    }
    if (typeof body.intentAnchor !== 'string' || body.intentAnchor.trim().length === 0) {
      return reply.status(400).send({ error: 'intentAnchor is required.' });
    }
    const status = typeof body.status === 'string' ? body.status : 'active';
    if (!validTaskStatuses.includes(status)) {
      return reply.status(400).send({ error: 'Invalid status.' });
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
    const scheduledJobId =
      typeof body.scheduledJobId === 'string' && body.scheduledJobId.trim().length > 0
        ? body.scheduledJobId.trim()
        : null;
    if (conversationId && !UUID_RE.test(conversationId)) {
      return reply.status(400).send({ error: 'Invalid conversationId: must be a valid UUID.' });
    }
    if (scheduledJobId && !UUID_RE.test(scheduledJobId)) {
      return reply.status(400).send({ error: 'Invalid scheduledJobId: must be a valid UUID.' });
    }

    const inserted = await pool.query(
      `INSERT INTO agent_tasks (agent_id, intent_anchor, status, progress, error_budget, conversation_id, scheduled_job_id, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, now())
       RETURNING id, agent_id, intent_anchor, status, progress, error_budget, conversation_id, scheduled_job_id, created_at, updated_at`,
      [
        body.agentId.trim(),
        body.intentAnchor.trim(),
        status,
        JSON.stringify((body.progress as Record<string, unknown> | undefined) ?? {}),
        JSON.stringify((body.errorBudget as Record<string, unknown> | undefined) ?? {}),
        conversationId,
        scheduledJobId,
      ],
    );
    if (!inserted.rowCount) {
      logger.error('kg: INSERT agent_tasks returned no rows');
      return reply.status(500).send({ error: 'Failed to create task.' });
    }
    return reply.status(201).send({
      task: serializeTask(
        inserted.rows[0]! as {
          id: string;
          agent_id: string;
          intent_anchor: string;
          status: string;
          progress: Record<string, unknown> | null;
          error_budget: Record<string, unknown> | null;
          conversation_id: string | null;
          scheduled_job_id: string | null;
          created_at: string;
          updated_at: string;
        },
      ),
    });
  });

  app.patch('/api/kg/tasks/:id', KG_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;
    const { id } = request.params as { id: string };
    if (!UUID_RE.test(id)) {
      return reply.status(400).send({ error: 'Invalid task id.' });
    }
    const body = request.body as {
      agentId?: unknown;
      intentAnchor?: unknown;
      status?: unknown;
      progress?: unknown;
      errorBudget?: unknown;
      conversationId?: unknown;
      scheduledJobId?: unknown;
    };

    const existing = await pool.query(
      `SELECT id, agent_id, intent_anchor, status, progress, error_budget, conversation_id, scheduled_job_id, created_at, updated_at
       FROM agent_tasks
       WHERE id = $1`,
      [id],
    );
    if (existing.rowCount === 0) {
      return reply.status(404).send({ error: 'Agent task not found.' });
    }
    const row = existing.rows[0] as {
      id: string;
      agent_id: string;
      intent_anchor: string;
      status: string;
      progress: Record<string, unknown> | null;
      error_budget: Record<string, unknown> | null;
      conversation_id: string | null;
      scheduled_job_id: string | null;
      created_at: string;
      updated_at: string;
    };

    const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : row.agent_id;
    const intentAnchor = typeof body.intentAnchor === 'string' ? body.intentAnchor.trim() : row.intent_anchor;
    const status = typeof body.status === 'string' ? body.status : row.status;
    if (!agentId) return reply.status(400).send({ error: 'agentId is required.' });
    if (!intentAnchor) return reply.status(400).send({ error: 'intentAnchor is required.' });
    if (!validTaskStatuses.includes(status)) {
      return reply.status(400).send({ error: 'Invalid status.' });
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
    const scheduledJobId =
      typeof body.scheduledJobId === 'string'
        ? body.scheduledJobId.trim() || null
        : body.scheduledJobId === null
        ? null
        : row.scheduled_job_id;
    if (conversationId && !UUID_RE.test(conversationId)) {
      return reply.status(400).send({ error: 'Invalid conversationId: must be a valid UUID.' });
    }
    if (scheduledJobId && !UUID_RE.test(scheduledJobId)) {
      return reply.status(400).send({ error: 'Invalid scheduledJobId: must be a valid UUID.' });
    }

    const updated = await pool.query(
      `UPDATE agent_tasks
       SET agent_id = $2,
           intent_anchor = $3,
           status = $4,
           progress = $5::jsonb,
           error_budget = $6::jsonb,
           conversation_id = $7,
           scheduled_job_id = $8,
           updated_at = now()
       WHERE id = $1
       RETURNING id, agent_id, intent_anchor, status, progress, error_budget, conversation_id, scheduled_job_id, created_at, updated_at`,
      [
        id,
        agentId,
        intentAnchor,
        status,
        JSON.stringify((body.progress as Record<string, unknown> | undefined) ?? row.progress ?? {}),
        JSON.stringify((body.errorBudget as Record<string, unknown> | undefined) ?? row.error_budget ?? {}),
        conversationId,
        scheduledJobId,
      ],
    );
    // Guard against concurrent deletes between the existence check and the UPDATE.
    if (!updated.rowCount) {
      logger.warn({ taskId: id }, 'kg: PATCH agent_tasks matched 0 rows — likely concurrent delete');
      return reply.status(404).send({ error: 'Agent task not found.' });
    }
    return reply.send({
      task: serializeTask(
        updated.rows[0]! as {
          id: string;
          agent_id: string;
          intent_anchor: string;
          status: string;
          progress: Record<string, unknown> | null;
          error_budget: Record<string, unknown> | null;
          conversation_id: string | null;
          scheduled_job_id: string | null;
          created_at: string;
          updated_at: string;
        },
      ),
    });
  });

  app.delete('/api/kg/tasks/:id', KG_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;
    const { id } = request.params as { id: string };
    if (!UUID_RE.test(id)) {
      return reply.status(400).send({ error: 'Invalid task id.' });
    }
    const deleted = await pool.query('DELETE FROM agent_tasks WHERE id = $1', [id]);
    if (deleted.rowCount === 0) {
      return reply.status(404).send({ error: 'Agent task not found.' });
    }
    return reply.status(204).send();
  });

  app.get('/api/kg/contacts', KG_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;
    const contacts = await contactService.listContacts();
    return reply.send({
      contacts: contacts.map((contact) => ({
        id: contact.id,
        kgNodeId: contact.kgNodeId,
        displayName: contact.displayName,
        role: contact.role,
        status: contact.status,
        trustLevel: contact.trustLevel,
        systemRole: contact.systemRole,
        notes: contact.notes,
        createdAt: contact.createdAt.toISOString(),
        updatedAt: contact.updatedAt.toISOString(),
      })),
    });
  });

  app.post('/api/kg/contacts', KG_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;
    const body = request.body as {
      displayName?: unknown;
      role?: unknown;
      status?: unknown;
      trustLevel?: unknown;
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

    const kgNodeId =
      typeof body.kgNodeId === 'string' && body.kgNodeId.trim().length > 0
        ? body.kgNodeId.trim()
        : undefined;
    if (kgNodeId && !UUID_RE.test(kgNodeId)) {
      return reply.status(400).send({ error: 'Invalid kgNodeId: must be a valid UUID.' });
    }

    const created = await contactService.createContact({
      displayName: body.displayName,
      role: typeof body.role === 'string' && body.role.trim().length > 0 ? body.role : undefined,
      status: status as ContactStatus,
      notes: typeof body.notes === 'string' && body.notes.trim().length > 0 ? body.notes : undefined,
      kgNodeId,
      source: 'kg_web_ui',
    });

    // Apply trustLevel if provided — createContact always initialises it to null.
    if (typeof body.trustLevel === 'string') {
      await contactService.setTrustLevel(created.id, body.trustLevel as TrustLevel);
    }

    const freshCreated = await contactService.getContact(created.id);
    if (!freshCreated) {
      // Should never happen — contact was just created — but guard rather than return stale data.
      logger.error({ contactId: created.id }, 'POST /api/kg/contacts: contact not found after creation');
      return reply.status(500).send({ error: 'Contact created but could not be retrieved.' });
    }
    return reply.status(201).send({
      contact: {
        id: freshCreated.id,
        kgNodeId: freshCreated.kgNodeId,
        displayName: freshCreated.displayName,
        role: freshCreated.role,
        status: freshCreated.status,
        trustLevel: freshCreated.trustLevel,
        notes: freshCreated.notes,
        createdAt: freshCreated.createdAt.toISOString(),
        updatedAt: freshCreated.updatedAt.toISOString(),
      },
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

    if (typeof body.displayName === 'string') {
      await contactService.updateDisplayName(id, body.displayName);
    }
    if (typeof body.role === 'string') {
      await contactService.setRole(id, body.role);
    } else if (body.role === null) {
      // Explicit null means "clear the role field" — setRole doesn't accept null so go direct.
      await pool.query(`UPDATE contacts SET role = NULL, updated_at = $2 WHERE id = $1`, [
        id,
        new Date().toISOString(),
      ]);
    }
    if (typeof body.status === 'string') {
      await contactService.setStatus(id, body.status as ContactStatus);
    }
    if ('trustLevel' in body) {
      await contactService.setTrustLevel(id, (body.trustLevel as TrustLevel | null));
    }

    // Notes and kgNodeId are updated directly by preserving the rest of the contact.
    // This route exists only for the web UI and does not expose generic backend mutation.
    if (typeof body.notes === 'string' || typeof body.kgNodeId === 'string' || body.notes === null || body.kgNodeId === null) {
      const refreshed = await contactService.getContact(id);
      if (!refreshed) {
        return reply.status(404).send({ error: 'Contact not found.' });
      }
      await pool.query(
        `UPDATE contacts
         SET notes = $2, kg_node_id = $3, updated_at = $4
         WHERE id = $1`,
        [
          id,
          typeof body.notes === 'string' ? body.notes : body.notes === null ? null : refreshed.notes,
          normalizedKgNodeId !== undefined ? normalizedKgNodeId : refreshed.kgNodeId,
          new Date().toISOString(),
        ],
      );
    }

    const updated = await contactService.getContact(id);
    if (!updated) {
      return reply.status(404).send({ error: 'Contact not found after update.' });
    }
    return reply.send({
      contact: {
        id: updated.id,
        kgNodeId: updated.kgNodeId,
        displayName: updated.displayName,
        role: updated.role,
        status: updated.status,
        trustLevel: updated.trustLevel,
        notes: updated.notes,
        createdAt: updated.createdAt.toISOString(),
        updatedAt: updated.updatedAt.toISOString(),
      },
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
   * POST /api/kg/chat/messages — dispatch a chat message, wait for the agent response.
   *
   * Body: { message: string, conversationId?: string }
   * Response: { reply: string, conversationId: string }
   *
   * Mirrors the publish/wait pattern in POST /api/messages: register the waiter BEFORE
   * publishing so a fast response isn't missed, then map publish/timeout/rejection
   * errors to structured HTTP status codes.
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

    // Register the waiter BEFORE publishing so we don't race past a fast reply.
    const responsePromise = eventRouter.waitForResponse(conversationId, CHAT_RESPONSE_TIMEOUT_MS);

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
      // Publish failed synchronously — cancel our pending waiter (still ours, nothing
      // has had a chance to supersede it yet) and surface a 500.
      eventRouter.cancelPending(conversationId);
      const message = publishErr instanceof Error ? publishErr.message : String(publishErr);
      logger.error({ err: publishErr, conversationId }, 'KG chat message publish failed');
      return reply.status(500).send({ error: message });
    }

    try {
      const content = await responsePromise;
      return reply.send({ reply: content, html: markdownToHtml(content), conversationId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, conversationId }, 'KG chat message handling failed');
      // instanceof + reason check for rejection — string matching would silently break if the
      // error wording changes. Timeout still falls back to substring because the event
      // router doesn't expose a dedicated TimeoutError class.
      const isRejected = err instanceof MessageRejectedError;
      const isTooLarge = isRejected && err.reason === 'message_too_large';
      const isTimeout = message.includes('timeout') || message.includes('Timeout');
      const status = isTooLarge ? 413 : isRejected ? 403 : isTimeout ? 504 : 500;
      return reply.status(status).send({ error: message });
    }
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
  app.get('/api/kg/chat/history', async (request, reply) => {
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

      const messages = rows.map((row) => ({
        id: row.id,
        role: row.role as 'user' | 'assistant',
        content: row.content,
        // Pre-render HTML only for assistant messages — user text is displayed as-is.
        html: row.role === 'assistant' ? markdownToHtml(row.content) : null,
        timestamp: row.created_at.toISOString(),
      }));

      return reply.send({ messages, hasMore });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, conversationId }, 'KG chat history fetch failed');
      return reply.status(500).send({ error: message });
    }
  });
}
