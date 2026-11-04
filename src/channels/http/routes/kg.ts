// kg.ts — knowledge-graph primitives and console session login.
//
// Graph node/edge routes stay under /api/kg/*. Task, contact, and chat CRUD
// moved to their own route files under /api/* (#872).
//
// Auth for /api/kg/*: session cookie or x-web-bootstrap-secret via assertSecret.
// POST /auth mints the curia_session cookie used by all console routes.

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { EventBus } from '../../../bus/bus.js';
import { createOperatorSession } from '../../../bus/events.js';
import type { Logger } from '../../../logger.js';
import type { ContactService } from '../../../contacts/contact-service.js';
import { assertSecret, compareSecrets, CONSOLE_RATE, type SessionStore } from '../session-auth.js';
import {
  deleteSession,
  deviceNameFromUserAgent,
  evictTokenHashes,
  issueSession,
  readUserAgent,
  sessionCookieOptions,
} from '../console-sessions.js';
import { resolveConsoleOriginator } from '../console-originator.js';
import { isUuid } from '../../../util/uuid.js';
import type { NodeMergeApi } from '../../../kg-merge/service.js';
import { DEFAULT_CANDIDATES, MAX_CANDIDATES } from '../../../kg-merge/service.js';
import { parseResolutions } from '../../../kg-merge/resolve.js';
import {
  InvalidResolutionError,
  MergeBlockedError,
  NodeNotFoundError,
  StalePreviewError,
} from '../../../kg-merge/errors.js';

export interface KnowledgeGraphRouteOptions {
  pool: Pool;
  logger: Logger;
  webAppBootstrapSecret: string | undefined;
  // True when APP_ORIGIN is https:// — causes Set-Cookie to include the Secure flag.
  // False in local dev so cookies work on http://localhost without browser rejection.
  secureCookies: boolean;
  contactService: ContactService;
  // Shared session store — created in HttpAdapter, passed to KG and other console routes
  // so all can accept the curia_session cookie for authentication.
  sessions: SessionStore;
  // Node merge (#2233): POST /api/kg/nodes/merge and GET /api/kg/nodes/:id/merge-candidates.
  // Optional so callers that never mount the merge (tests) need not build one; when absent
  // those two routes answer 503.
  nodeMergeService?: NodeMergeApi;
  /** A successful sign-in is audited as operator.session. */
  bus: EventBus;
}

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

/** GET /api/kg/nodes also returns the alias list, identity tier and archived flag (#2233). */
interface KgNodeListRow extends KgNodeRow {
  aliases: string[] | null;
  identity_source: string;
  archived_at: string | null;
}

/** GET /api/kg/graph nodes carry the alias list and whether the node is archived (#2233). */
interface KgGraphNodeRow extends KgNodeRow {
  aliases: string[] | null;
  archived_at: string | null;
}

/**
 * SQL predicate: the row aliased `n` is NOT a merge tombstone — an archived node whose
 * properties name the survivor it was merged into (#2233). Decayed archived nodes (no
 * merged_into) still pass.
 */
function notMergeTombstone(alias: string): string {
  return `NOT (${alias}.archived_at IS NOT NULL AND ${alias}.properties->>'merged_into' IS NOT NULL)`;
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

/** Live node and edge counts for the whole graph, sent with every /api/kg/graph response (#2479). */
interface KgGraphTotals {
  nodes: number;
  edges: number;
  byType: Record<string, number>;
  bySensitivity: Record<string, number>;
}

/**
 * Counts the live graph — nodes and edges that are not archived — so the console can
 * say "X of Y shown" instead of presenting a capped canvas as the whole graph. Merge
 * tombstones are archived, so they are never counted.
 */
async function loadGraphTotals(pool: Pool): Promise<KgGraphTotals> {
  const groups = await pool.query<{ type: string; sensitivity: string; count: string }>(
    `SELECT type, COALESCE(sensitivity, 'internal') AS sensitivity, count(*)::text AS count
     FROM kg_nodes
     WHERE archived_at IS NULL
     GROUP BY type, COALESCE(sensitivity, 'internal')`,
  );
  const edges = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM kg_edges e
     JOIN kg_nodes s ON s.id = e.source_node_id AND s.archived_at IS NULL
     JOIN kg_nodes t ON t.id = e.target_node_id AND t.archived_at IS NULL
     WHERE e.archived_at IS NULL`,
  );
  const totals: KgGraphTotals = { nodes: 0, edges: Number(edges.rows[0]?.count ?? 0), byType: {}, bySensitivity: {} };
  for (const row of groups.rows) {
    const n = Number(row.count);
    totals.nodes += n;
    totals.byType[row.type] = (totals.byType[row.type] ?? 0) + n;
    totals.bySensitivity[row.sensitivity] = (totals.bySensitivity[row.sensitivity] ?? 0) + n;
  }
  return totals;
}

/**
 * The GET /api/kg/graph body. `truncated` is true when a limit cut nodes from the view;
 * `totals` describes the whole live graph, not this response.
 */
function graphPayload(nodes: KgGraphNodeRow[], edges: KgEdgeRow[], truncated: boolean, totals: KgGraphTotals) {
  return {
    nodes: nodes.map((row) => ({
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
      aliases: row.aliases ?? [],
      archived: row.archived_at !== null && row.archived_at !== undefined,
    })),
    edges: edges.map((row) => ({
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
    truncated,
    totals,
  };
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
  const { pool, logger, webAppBootstrapSecret, secureCookies, contactService, sessions, nodeMergeService, bus } = options;
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
    // Idle window is 90 days and slides on later requests (ADR-055). The plaintext
    // token stays in the cookie; Postgres stores only its hash.
    const userAgent = readUserAgent(request);
    let issued: Awaited<ReturnType<typeof issueSession>>;
    try {
      issued = await issueSession(pool, sessions, {
        kind: 'browser',
        name: deviceNameFromUserAgent(userAgent),
        userAgent,
      });
    } catch (err) {
      logger.error({ err }, 'Failed to persist session to Postgres');
      return reply.status(503).send({ error: 'Login is temporarily unavailable. Please try again.' });
    }

    const name = deviceNameFromUserAgent(userAgent);
    try {
      // The access key is what authenticated. The new session is the target.
      await bus.publish('system', createOperatorSession({
        action: 'login',
        stage: 'completed',
        initiatedBy: 'bootstrap_secret',
        sessionId: issued.id,
        kind: 'browser',
        name,
      }));
    } catch (err) {
      logger.error({ err, sessionId: issued.id }, 'POST /auth: failed to record login — removing the new session');
      try {
        await deleteSession(pool, issued.id);
      } catch (deleteErr) {
        logger.error({ err: deleteErr, sessionId: issued.id }, 'POST /auth: failed to roll back an unaudited session');
      }
      evictTokenHashes(sessions, [issued.tokenHash]);
      return reply.status(500).send({ error: 'Failed to record the sign-in. Please try again.' });
    }

    reply.setCookie('curia_session', issued.token, sessionCookieOptions(secureCookies));

    return reply.status(200).send({ ok: true });
  });

  // Rate limit for KG API endpoints: shared console 60/min per IP.
  const KG_RATE = CONSOLE_RATE;

  app.get('/api/kg/nodes', KG_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;

    const query = request.query as {
      query?: string;
      type?: string;
      limit?: string;
      exclude_facts?: string;
    };

    const limit = normalizeLimit(query.limit, 50, 250);
    const searchQuery = query.query?.trim();
    const typeFilter = query.type?.trim();
    // exclude_facts=true drops fact nodes — the merge picker searches entities only (#2233).
    const excludeFacts = query.exclude_facts === 'true' || query.exclude_facts === '1';

    // Merge tombstones are excluded (#2233), the same rule /api/kg/graph applies: a
    // merged-away node lives on only as a redirect to its survivor. Decayed archived nodes
    // are still listed, flagged `archived`, so the list and the graph agree. The text
    // search also matches aliases, so a node is found by a name it was merged from.
    const result = await pool.query<KgNodeListRow>(
      `SELECT id, type, label, properties, confidence, decay_class, source, created_at, last_confirmed_at, sensitivity,
              aliases, identity_source, archived_at
       FROM kg_nodes
       WHERE ${notMergeTombstone('kg_nodes')}
         AND ($1::text IS NULL OR type = $1)
         AND (NOT $4::boolean OR type <> 'fact')
         AND (
           $2::text IS NULL
           OR label ILIKE '%' || $2 || '%'
           OR properties::text ILIKE '%' || $2 || '%'
           OR EXISTS (SELECT 1 FROM unnest(aliases) AS a(alias) WHERE a.alias ILIKE '%' || $2 || '%')
         )
       ORDER BY last_confirmed_at DESC
       LIMIT $3`,
      [typeFilter || null, searchQuery || null, limit, excludeFacts],
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
        aliases: row.aliases ?? [],
        identitySource: row.identity_source === 'contact' ? 'contact' : 'label',
        archived: row.archived_at !== null && row.archived_at !== undefined,
      })),
    });
  });

  app.get('/api/kg/graph', KG_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;

    const query = request.query as {
      node_id?: string;
      depth?: string;
      limit?: string;
      scope?: string;
      include_facts?: string;
      exclude_facts?: string;
    };

    const nodeId = query.node_id?.trim();
    const depth = normalizeLimit(query.depth, 2, 4);
    const limit = normalizeLimit(query.limit, 100, 300);
    const isTrue = (raw: string | undefined): boolean => raw === 'true' || raw === '1';

    // Reject malformed UUIDs before they reach SQL — Postgres would throw a cast error
    // and surface as a 500 rather than a useful 400 for the caller.
    if (nodeId && !isUuid(nodeId)) {
      return reply.status(400).send({ error: 'Invalid node_id: must be a valid UUID.' });
    }
    if (query.scope !== undefined && query.scope !== 'all') {
      return reply.status(400).send({ error: "Invalid scope: the only supported value is 'all'." });
    }
    if (query.scope === 'all' && nodeId) {
      return reply.status(400).send({ error: 'scope=all cannot be combined with node_id.' });
    }

    // scope=all (#2479): the whole live graph — every unarchived node and every
    // unarchived edge between two of them, with no limit. Facts are left out unless
    // include_facts=true: they are about half the graph and hang off a single entity.
    if (query.scope === 'all') {
      const includeFacts = isTrue(query.include_facts);
      const nodes = await pool.query<KgGraphNodeRow>(
        `SELECT id, type, label, properties, confidence, decay_class, source, created_at, last_confirmed_at, sensitivity,
                aliases, archived_at
         FROM kg_nodes
         WHERE archived_at IS NULL
           AND ($1::boolean OR type <> 'fact')`,
        [includeFacts],
      );
      const edges = await pool.query<KgEdgeRow>(
        `SELECT e.id, e.source_node_id, e.target_node_id, e.type, e.properties, e.confidence, e.decay_class, e.source,
                e.created_at, e.last_confirmed_at
         FROM kg_edges e
         JOIN kg_nodes s ON s.id = e.source_node_id AND s.archived_at IS NULL
         JOIN kg_nodes t ON t.id = e.target_node_id AND t.archived_at IS NULL
         WHERE e.archived_at IS NULL
           AND ($1::boolean OR (s.type <> 'fact' AND t.type <> 'fact'))`,
        [includeFacts],
      );
      const totals = await loadGraphTotals(pool);
      logger.debug({ nodes: nodes.rowCount, edges: edges.rowCount, includeFacts }, 'kg: full graph served');
      return reply.send(graphPayload(nodes.rows, edges.rows, false, totals));
    }

    // Both bounded views fetch one row past the limit so the response can say whether
    // the limit cut anything (`truncated`), rather than passing a slice off as the whole.
    //
    // Merge tombstones (#2233) are never drawn or traversed through; only the focal node
    // itself (the CTE anchor) may be one, so the 404 node_merged below can name the survivor.
    //
    // The focal view ranks by hop distance first, then recency (#2479). Ranking on
    // recency alone let newer two-hop nodes push the focal node itself and its direct
    // neighbours out of a well-connected node's view. The anchor is depth 0, so it is
    // always kept. UNION (not UNION ALL) dedupes (id, depth) pairs, which bounds the walk
    // to nodes × depth rows instead of enumerating every path.
    const nodeResult = nodeId
      ? await pool.query<KgGraphNodeRow>(
          `WITH RECURSIVE traversal(id, depth) AS (
             SELECT id, 0
             FROM kg_nodes
             WHERE id = $1::uuid
             UNION
             SELECT o.id, t.depth + 1
             FROM traversal t
             JOIN kg_edges e ON e.source_node_id = t.id OR e.target_node_id = t.id
             JOIN kg_nodes o ON o.id = CASE WHEN e.source_node_id = t.id THEN e.target_node_id ELSE e.source_node_id END
             WHERE t.depth < $2
               AND ${notMergeTombstone('o')}
           ),
           reached AS (
             SELECT id, min(depth) AS depth FROM traversal GROUP BY id
           )
           SELECT n.id, n.type, n.label, n.properties, n.confidence, n.decay_class, n.source, n.created_at, n.last_confirmed_at, n.sensitivity,
                  n.aliases, n.archived_at
           FROM reached r
           JOIN kg_nodes n ON n.id = r.id
           ORDER BY r.depth, n.last_confirmed_at DESC
           LIMIT $3`,
          [nodeId, depth, limit + 1],
        )
      : await pool.query<KgGraphNodeRow>(
          `SELECT id, type, label, properties, confidence, decay_class, source, created_at, last_confirmed_at, sensitivity,
                  aliases, archived_at
           FROM kg_nodes n
           WHERE ${notMergeTombstone('n')}
             AND (NOT $2::boolean OR type <> 'fact')
           ORDER BY last_confirmed_at DESC
           LIMIT $1`,
          [limit + 1, isTrue(query.exclude_facts)],
        );

    const truncated = nodeResult.rows.length > limit;
    const nodeRows = truncated ? nodeResult.rows.slice(0, limit) : nodeResult.rows;

    if (nodeRows.length === 0) {
      // With a focal node_id the CTE anchor is that node itself: zero rows means no
      // kg_nodes row (including archived — the anchor is never filtered). An
      // isolated node still yields exactly one row (itself) and an empty edge list
      // below — keep that as 200 so callers can tell the two apart (#1881).
      if (nodeId) {
        logger.debug({ nodeId }, 'kg: graph node not found');
        return reply.status(404).send({ error: `Node not found: ${nodeId}` });
      }
      return reply.send(graphPayload([], [], false, await loadGraphTotals(pool)));
    }

    // A deep link to a node that was merged away (#2233): send the console to the
    // survivor instead of drawing the tombstone. An archived node without merged_into
    // (decayed) keeps the behaviour above — it is still drawn.
    if (nodeId) {
      const focal = nodeRows.find((row) => row.id === nodeId);
      const mergedInto = focal?.properties?.merged_into;
      if (focal?.archived_at && typeof mergedInto === 'string' && mergedInto.length > 0) {
        logger.debug({ nodeId, mergedInto }, 'kg: graph node was merged away');
        return reply.status(404).send({
          error: `Node ${nodeId} was merged into ${mergedInto}.`,
          code: 'node_merged',
          mergedInto,
          label: focal.label,
        });
      }
    }

    // Every edge between the returned nodes. The node set is capped (at most `limit`),
    // so this is bounded without a LIMIT of its own — a cap here silently dropped edges.
    const nodeIds = nodeRows.map((row) => row.id);
    const edgeResult = await pool.query<KgEdgeRow>(
      `SELECT id, source_node_id, target_node_id, type, properties, confidence, decay_class, source, created_at, last_confirmed_at
       FROM kg_edges
       WHERE source_node_id = ANY($1::uuid[])
         AND target_node_id = ANY($1::uuid[])`,
      [nodeIds],
    );
    const totals = await loadGraphTotals(pool);

    logger.debug({ nodes: nodeRows.length, edges: edgeResult.rowCount, truncated }, 'kg: graph query served');

    return reply.send(graphPayload(nodeRows, edgeResult.rows, truncated, totals));
  });

  // ── Node merge (#2233, docs/wip/2026-10-21-kg-node-merge-design.md §8) ──────────

  /** Map a merge failure to its HTTP response; null when it is not a merge error. */
  function mergeErrorResponse(err: unknown): { status: number; body: Record<string, unknown> } | null {
    if (err instanceof InvalidResolutionError) return { status: 400, body: { error: err.message, code: err.code } };
    if (err instanceof NodeNotFoundError) return { status: 404, body: { error: err.message, code: err.code } };
    if (err instanceof StalePreviewError) return { status: 409, body: { error: err.message, code: err.code } };
    if (err instanceof MergeBlockedError) {
      return { status: 422, body: { error: err.message, code: err.code, blockers: err.blockers } };
    }
    return null;
  }

  // POST /api/kg/nodes/merge — preview (dryRun, the default) or apply a node merge.
  app.post('/api/kg/nodes/merge', KG_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;
    if (!nodeMergeService) {
      return reply.status(503).send({ error: 'Node merge is not available.', code: 'unavailable' });
    }

    const body = (request.body ?? {}) as {
      survivorId?: unknown;
      absorbedId?: unknown;
      dryRun?: unknown;
      planToken?: unknown;
      resolutions?: unknown;
    };
    const invalid = (error: string) => reply.status(400).send({ error, code: 'invalid_request' });
    const survivorId = typeof body.survivorId === 'string' ? body.survivorId.trim() : '';
    const absorbedId = typeof body.absorbedId === 'string' ? body.absorbedId.trim() : '';
    if (!isUuid(survivorId) || !isUuid(absorbedId)) {
      return invalid('survivorId and absorbedId must be valid UUIDs.');
    }
    if (survivorId.toLowerCase() === absorbedId.toLowerCase()) {
      return invalid('survivorId and absorbedId must differ.');
    }
    if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') {
      return invalid('dryRun must be a boolean.');
    }
    const dryRun = body.dryRun !== false;

    try {
      if (dryRun) {
        // JSON body (Fastify serializes the object as application/json), not HTML;
        // resp.render() does not apply. Same send path as the other KG JSON routes.
        // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write
        return reply.send(await nodeMergeService.preview(survivorId, absorbedId));
      }
      if (typeof body.planToken !== 'string' || body.planToken.trim().length === 0) {
        return invalid('planToken is required when dryRun is false. Preview the merge first.');
      }
      const resolutions = parseResolutions(body.resolutions);
      const actor = await resolveConsoleOriginator(contactService, logger);
      const result = await nodeMergeService.apply({
        survivorId,
        absorbedId,
        planToken: body.planToken.trim(),
        resolutions,
        actor,
      });
      // JSON body (Fastify serializes the object as application/json), not HTML;
      // resp.render() does not apply. Same send path as the other KG JSON routes.
      // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write
      return reply.send(result);
    } catch (err) {
      const mapped = mergeErrorResponse(err);
      if (mapped) return reply.status(mapped.status).send(mapped.body);
      logger.error({ err, survivorId, absorbedId, dryRun }, 'POST /api/kg/nodes/merge failed');
      return reply.status(500).send({ error: dryRun ? 'Failed to preview node merge.' : 'Failed to merge nodes.' });
    }
  });

  // GET /api/kg/nodes/:id/merge-candidates?limit=8 — likely duplicates of any type.
  app.get('/api/kg/nodes/:id/merge-candidates', KG_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;
    if (!nodeMergeService) {
      return reply.status(503).send({ error: 'Node merge is not available.', code: 'unavailable' });
    }
    const { id } = request.params as { id: string };
    if (!isUuid(id)) {
      return reply.status(400).send({ error: 'Invalid node id: must be a valid UUID.', code: 'invalid_request' });
    }
    const limit = normalizeLimit((request.query as { limit?: string }).limit, DEFAULT_CANDIDATES, MAX_CANDIDATES);
    try {
      const candidates = await nodeMergeService.candidates(id, limit);
      return reply.send({ candidates });
    } catch (err) {
      const mapped = mergeErrorResponse(err);
      if (mapped) return reply.status(mapped.status).send(mapped.body);
      logger.error({ err, nodeId: id }, 'GET /api/kg/nodes/:id/merge-candidates failed');
      return reply.status(500).send({ error: 'Failed to load merge candidates.' });
    }
  });
}
