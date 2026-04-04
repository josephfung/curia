import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { Logger } from '../../../logger.js';

export interface KnowledgeGraphRouteOptions {
  pool: Pool;
  logger: Logger;
  webAppBootstrapSecret: string | undefined;
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

function assertSecret(
  request: FastifyRequest,
  reply: FastifyReply,
  configuredSecret: string | undefined,
): boolean {
  if (!configuredSecret) {
    reply.status(503).send({
      error: 'Knowledge graph web UI is disabled. Set WEB_APP_BOOTSTRAP_SECRET in .env to enable it.',
    });
    return false;
  }

  const provided = request.headers['x-web-bootstrap-secret'];
  if (typeof provided !== 'string' || provided !== configuredSecret) {
    reply.status(401).send({
      error: 'Unauthorized. Provide WEB_APP_BOOTSTRAP_SECRET via the x-web-bootstrap-secret header.',
    });
    return false;
  }

  return true;
}

function createUiHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Curia Knowledge Graph Explorer</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; font-family: Inter, system-ui, sans-serif; background: #111827; color: #f3f4f6; }
    header { padding: 1rem; border-bottom: 1px solid #374151; display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; }
    input, button { border-radius: .5rem; border: 1px solid #4b5563; background: #1f2937; color: #f9fafb; padding: .5rem .75rem; }
    button { cursor: pointer; }
    #layout { display: grid; grid-template-columns: 320px 1fr; min-height: calc(100vh - 78px); }
    #sidebar { border-right: 1px solid #374151; padding: 1rem; overflow: auto; }
    #graph { width: 100%; height: calc(100vh - 78px); }
    .node-result { padding: .6rem; border: 1px solid #374151; border-radius: .5rem; margin-bottom: .5rem; cursor: pointer; }
    .node-result:hover { border-color: #60a5fa; }
    .meta { color: #9ca3af; font-size: .85rem; }
    #status { color: #93c5fd; min-height: 1.2rem; }
  </style>
</head>
<body>
  <header>
    <strong>Knowledge Graph Explorer</strong>
    <input id="secret" type="password" placeholder="WEB_APP_BOOTSTRAP_SECRET" style="width: 220px" />
    <button id="saveSecret">Use Secret</button>
    <input id="search" placeholder="Search label or properties..." style="width: 360px" />
    <button id="searchBtn">Search</button>
    <span id="status"></span>
  </header>
  <div id="layout">
    <aside id="sidebar">
      <h3>Nodes</h3>
      <div id="results"></div>
    </aside>
    <main><div id="graph"></div></main>
  </div>

  <script src="/kg/assets/cytoscape.min.js"></script>
  <script>
    const statusEl = document.getElementById('status');
    const resultsEl = document.getElementById('results');
    const searchInput = document.getElementById('search');
    const searchBtn = document.getElementById('searchBtn');
    const secretInput = document.getElementById('secret');
    const saveSecretBtn = document.getElementById('saveSecret');
    const graphEl = document.getElementById('graph');

    // Guard against missing DOM elements — all are defined in the HTML above, but this
    // catches template/script divergence early with a readable error instead of a
    // cryptic null-dereference later.
    if (!statusEl || !resultsEl || !searchInput || !searchBtn || !secretInput || !saveSecretBtn || !graphEl) {
      throw new Error('KG Explorer: required DOM element missing — check template integrity.');
    }

    secretInput.value = sessionStorage.getItem('web_app_bootstrap_secret') || '';

    const cy = cytoscape({
      container: graphEl,
      elements: [],
      style: [
        { selector: 'node', style: { label: 'data(label)', 'background-color': '#3b82f6', color: '#f8fafc', 'text-valign': 'center', 'text-halign': 'center', 'font-size': 10, width: 30, height: 30 } },
        { selector: 'node[type="person"]', style: { 'background-color': '#10b981' } },
        { selector: 'node[type="organization"]', style: { 'background-color': '#f59e0b' } },
        { selector: 'node[type="project"]', style: { 'background-color': '#8b5cf6' } },
        { selector: 'edge', style: { width: 2, 'line-color': '#6b7280', 'curve-style': 'bezier', 'target-arrow-shape': 'triangle', 'target-arrow-color': '#6b7280', label: 'data(label)', 'font-size': 9, color: '#d1d5db' } }
      ],
      layout: { name: 'cose', animate: false }
    });

    function getSecret() {
      return secretInput.value.trim();
    }

    function setStatus(message, isError = false) {
      statusEl.textContent = message;
      statusEl.style.color = isError ? '#fca5a5' : '#93c5fd';
    }

    async function fetchJson(url) {
      const secret = getSecret();
      const headers = secret ? { 'x-web-bootstrap-secret': secret } : {};
      const response = await fetch(url, { headers });
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    }

    function renderResults(nodes) {
      resultsEl.replaceChildren();
      if (nodes.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'meta';
        empty.textContent = 'No matching nodes.';
        resultsEl.appendChild(empty);
        return;
      }

      nodes.forEach((node) => {
        const card = document.createElement('div');
        card.className = 'node-result';
        // Use textContent (not innerHTML) to prevent stored XSS — node labels and types
        // come from the database and could contain HTML/JS payloads from imported sources.
        const title = document.createElement('strong');
        title.textContent = node.label;
        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = node.type + ' · confidence ' + node.confidence.toFixed(2);
        card.append(title, meta);
        card.addEventListener('click', () => loadNeighborhood(node.id));
        resultsEl.appendChild(card);
      });
    }

    function renderGraph(payload) {
      const elements = [];
      payload.nodes.forEach((n) => elements.push({ data: { id: n.id, label: n.label, type: n.type } }));
      payload.edges.forEach((e) => elements.push({ data: { id: e.id, source: e.sourceNodeId, target: e.targetNodeId, label: e.type } }));
      cy.elements().remove();
      cy.add(elements);
      cy.layout({ name: 'cose', animate: false, fit: true }).run();
    }

    async function search() {
      try {
        setStatus('Searching...');
        const q = encodeURIComponent(searchInput.value.trim());
        const data = await fetchJson('/api/kg/nodes?query=' + q + '&limit=100');
        renderResults(data.nodes);
        setStatus('Found ' + data.nodes.length + ' nodes');
      } catch (error) {
        setStatus(String(error), true);
      }
    }

    async function loadNeighborhood(nodeId) {
      try {
        setStatus('Loading neighborhood...');
        const data = await fetchJson('/api/kg/graph?node_id=' + encodeURIComponent(nodeId) + '&depth=2');
        renderGraph(data);
        setStatus('Loaded ' + data.nodes.length + ' nodes and ' + data.edges.length + ' edges');
      } catch (error) {
        setStatus(String(error), true);
      }
    }

    saveSecretBtn.addEventListener('click', () => {
      sessionStorage.setItem('web_app_bootstrap_secret', getSecret());
      setStatus('Secret stored in this browser session.');
    });

    searchBtn.addEventListener('click', search);
    searchInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') search(); });
    if (getSecret()) search();
  </script>
</body>
</html>`;
}

export async function knowledgeGraphRoutes(
  app: FastifyInstance,
  options: KnowledgeGraphRouteOptions,
): Promise<void> {
  const { pool, logger, webAppBootstrapSecret } = options;

  app.get('/kg', async (_request, reply) => {
    reply.type('text/html; charset=utf-8').send(createUiHtml());
  });

  app.get('/kg/assets/cytoscape.min.js', async (_request, reply) => {
    const cytoscapePath = fileURLToPath(
      new URL('../../../../node_modules/cytoscape/dist/cytoscape.min.js', import.meta.url),
    );
    const source = await readFile(cytoscapePath, 'utf8');
    reply.type('application/javascript; charset=utf-8').send(source);
  });

  app.get('/api/kg/nodes', async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret)) return;

    const query = request.query as {
      query?: string;
      type?: string;
      limit?: string;
    };

    const limit = normalizeLimit(query.limit, 50, 250);
    const searchQuery = query.query?.trim();
    const typeFilter = query.type?.trim();

    const result = await pool.query<KgNodeRow>(
      `SELECT id, type, label, properties, confidence, decay_class, source, created_at, last_confirmed_at
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
      })),
    });
  });

  app.get('/api/kg/graph', async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret)) return;

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
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
           SELECT DISTINCT n.id, n.type, n.label, n.properties, n.confidence, n.decay_class, n.source, n.created_at, n.last_confirmed_at
           FROM traversal t
           JOIN kg_nodes n ON n.id = t.id
           ORDER BY n.last_confirmed_at DESC
           LIMIT $3`,
          [nodeId, depth, limit],
        )
      : await pool.query<KgNodeRow>(
          `SELECT id, type, label, properties, confidence, decay_class, source, created_at, last_confirmed_at
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
      })),
      edges: edgeResult.rows.map((row) => ({
        id: row.id,
        sourceNodeId: row.source_node_id,
        targetNodeId: row.target_node_id,
        type: row.type,
        properties: row.properties,
        confidence: row.confidence,
        decayClass: row.decay_class,
        source: row.source,
        createdAt: row.created_at,
        lastConfirmedAt: row.last_confirmed_at,
      })),
    });
  });
}
