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

// Design tokens — dark mode, from the Curia design system (theme.md).
// Keeping them here as a reference makes it easy to update the palette in one place
// without hunting through inline styles.
function createUiHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Curia</title>

  <!-- Manrope (body/UI) + Lora (headings/wordmark) from Google Fonts -->
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700&family=Lora:wght@500&display=swap" rel="stylesheet" />

  <!-- Tailwind CSS browser runtime — layout utilities only; colours come from CSS vars below -->
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      theme: {
        fontFamily: {
          sans: ['Manrope', 'system-ui', 'sans-serif'],
          serif: ['Lora', 'Georgia', 'serif'],
        },
        extend: {},
      },
    };
  </script>

  <style>
    /* ── Design tokens (dark mode) ──────────────────────────────────── */
    :root {
      --bg:           #111111;   /* oklch(0.145 0 0) */
      --card:         #1E1E1E;   /* oklch(0.205 0 0) */
      --sidebar-bg:   #1E1E1E;
      --muted:        #373737;   /* oklch(0.269 0 0) */
      --accent:       #555555;   /* oklch(0.371 0 0) — hover bg */
      --border:       rgba(255,255,255,0.10);
      --input-border: rgba(255,255,255,0.15);
      --primary:      #DEDEDE;   /* oklch(0.87 0 0) */
      --primary-fg:   #1E1E1E;
      --fg:           #FAFAFA;   /* oklch(0.985 0 0) */
      --fg-muted:     #ADADAD;   /* oklch(0.708 0 0) */
      --destructive:  #E86040;   /* oklch(0.704 0.191 22.216) */
      --teal:         #478189;   /* accent: active indicators */
      --chart-2:      #4174C8;   /* default node colour */
      --chart-1:      #6BAED6;   /* organization node */

      --radius-sm: 6px;
      --radius-md: 8px;
      --radius-lg: 10px;
    }

    *, *::before, *::after { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; overflow: hidden; }

    body {
      background: var(--bg);
      color: var(--fg);
      font-family: 'Manrope', system-ui, sans-serif;
      font-size: 14px;
    }

    /* ── Sidebar nav items ──────────────────────────────────────────── */
    .nav-item {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 6px 10px;
      border-radius: var(--radius-md);
      border: none;
      background: none;
      color: var(--fg-muted);
      font-family: inherit;
      font-size: 0.875rem;
      font-weight: 500;
      cursor: pointer;
      text-align: left;
      transition: background 0.12s, color 0.12s;
    }
    .nav-item:hover  { background: var(--accent); color: var(--fg); }
    .nav-item.active { background: var(--muted);  color: var(--fg); }

    /* Sub-items are inset to sit under their parent */
    .nav-sub-item {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 5px 10px 5px 28px;
      border-radius: var(--radius-md);
      border: none;
      background: none;
      color: var(--fg-muted);
      font-family: inherit;
      font-size: 0.8125rem;
      font-weight: 500;
      cursor: pointer;
      text-align: left;
      transition: background 0.12s, color 0.12s;
    }
    .nav-sub-item:hover  { background: var(--accent); color: var(--fg); }
    .nav-sub-item.active { background: var(--muted);  color: var(--fg); }

    /* ── Node cards in the result list ──────────────────────────────── */
    .node-card {
      padding: 8px 10px;
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      margin-bottom: 4px;
      cursor: pointer;
      transition: border-color 0.12s, background 0.12s;
    }
    .node-card:hover {
      border-color: var(--teal);
      background: rgba(71,129,137,0.08);
    }

    /* ── Form elements ───────────────────────────────────────────────── */
    input[type="text"],
    input[type="password"] {
      background: var(--muted);
      border: 1px solid var(--input-border);
      border-radius: var(--radius-md);
      color: var(--fg);
      font-family: inherit;
      font-size: 0.875rem;
      padding: 8px 12px;
      outline: none;
      width: 100%;
      transition: border-color 0.12s;
    }
    input[type="text"]:focus,
    input[type="password"]:focus { border-color: var(--teal); }

    /* ── Buttons ─────────────────────────────────────────────────────── */
    .btn-primary {
      background: var(--primary);
      color: var(--primary-fg);
      border: none;
      border-radius: var(--radius-md);
      font-family: inherit;
      font-size: 0.875rem;
      font-weight: 600;
      padding: 8px 16px;
      cursor: pointer;
      white-space: nowrap;
      transition: opacity 0.12s;
    }
    .btn-primary:hover    { opacity: 0.88; }
    .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

    /* ── Cytoscape canvas ─────────────────────────────────────────────── */
    #cy { width: 100%; height: 100%; }

    /* ── Subtle scrollbars ───────────────────────────────────────────── */
    ::-webkit-scrollbar       { width: 5px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--accent); border-radius: 99px; }

    /* ── Chevron rotation for expand/collapse ──────────────────────── */
    .chevron               { transition: transform 0.2s; }
    .chevron.collapsed     { transform: rotate(-90deg); }
  </style>
</head>
<body>

  <!-- ================================================================
       AUTH WALL — shown until the correct access key is supplied.
       Blocks the entire viewport; dismissed via JS once validated.
  ================================================================= -->
  <div id="auth-wall" style="position: fixed; inset: 0; z-index: 50; display: flex; align-items: center; justify-content: center; background: var(--bg);">
    <div style="width: 100%; max-width: 360px; margin: 0 1rem; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 2rem;">
      <div style="text-align: center; margin-bottom: 1.75rem;">
        <div style="font-family: 'Lora', Georgia, serif; font-size: 1.375rem; font-weight: 500; letter-spacing: 0.06em; color: var(--fg); margin-bottom: 0.375rem;">CURIA</div>
        <div style="font-size: 0.8125rem; color: var(--fg-muted);">Enter your access key to continue</div>
      </div>
      <form id="auth-form">
        <input id="auth-input" type="password" placeholder="Access key" autocomplete="current-password" style="margin-bottom: 0.75rem;" />
        <button type="submit" class="btn-primary" style="width: 100%; padding: 10px;">Enter</button>
        <div id="auth-error" style="display: none; margin-top: 0.75rem; font-size: 0.75rem; text-align: center; color: var(--destructive);">
          Invalid access key — please try again.
        </div>
      </form>
    </div>
  </div>

  <!-- ================================================================
       MAIN APP — revealed after successful authentication.
  ================================================================= -->
  <div id="main-app" style="display: none; height: 100vh; flex-direction: row; overflow: hidden;">

    <!-- ── Left sidebar ─────────────────────────────────────────────── -->
    <nav style="flex: none; width: 220px; display: flex; flex-direction: column; padding: 16px 10px; background: var(--sidebar-bg); border-right: 1px solid var(--border); overflow-y: auto;">

      <!-- Wordmark — placeholder for logo -->
      <div style="padding: 4px 10px 20px;">
        <span style="font-family: 'Lora', Georgia, serif; font-size: 1.125rem; font-weight: 500; letter-spacing: 0.06em; color: var(--fg);">CURIA</span>
      </div>

      <!-- Nav tree -->
      <div style="display: flex; flex-direction: column; gap: 2px;">

        <!-- Chat -->
        <button id="nav-chat" class="nav-item" onclick="navigate('coming-soon', 'Chat', 'nav-chat')">
          <!-- speech-bubble icon -->
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M13 9.5A1.5 1.5 0 0 1 11.5 11H4L1.5 13.5V3A1.5 1.5 0 0 1 3 1.5h8.5A1.5 1.5 0 0 1 13 3v6.5z"/>
          </svg>
          Chat
        </button>

        <!-- Memory (expandable section) -->
        <div>
          <button class="nav-item" id="memory-toggle" onclick="toggleMemory()">
            <!-- database-stack icon -->
            <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <ellipse cx="7.5" cy="4" rx="5.5" ry="2.5"/>
              <path d="M2 4v3.5C2 9.157 4.462 10.5 7.5 10.5S13 9.157 13 7.5V4"/>
              <path d="M2 7.5v3C2 12.157 4.462 13.5 7.5 13.5S13 12.157 13 10.5v-3"/>
            </svg>
            Memory
            <!-- chevron rotates when the section collapses -->
            <svg id="memory-chevron" class="chevron" style="margin-left: auto;" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 4.5L6 7.5L9 4.5"/>
            </svg>
          </button>

          <div id="memory-submenu" style="display: flex; flex-direction: column; gap: 2px; margin-top: 2px;">
            <!-- Knowledge Graph — active by default -->
            <button id="nav-kg" class="nav-sub-item active" onclick="navigate('kg', 'Knowledge Graph', 'nav-kg')">
              <!-- nodes-and-edges icon -->
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="6.5" cy="6.5" r="1.5"/>
                <circle cx="2"   cy="3.5" r="1.5"/>
                <circle cx="11"  cy="3.5" r="1.5"/>
                <circle cx="2"   cy="9.5" r="1.5"/>
                <circle cx="11"  cy="9.5" r="1.5"/>
                <line x1="3.5"  y1="4.5"  x2="5"   y2="5.5"/>
                <line x1="8"    y1="5.5"  x2="9.5"  y2="4.5"/>
                <line x1="5"    y1="7.5"  x2="3.5"  y2="8.5"/>
                <line x1="9.5"  y1="8.5"  x2="8"    y2="7.5"/>
              </svg>
              Knowledge Graph
            </button>

            <button id="nav-contacts" class="nav-sub-item" onclick="navigate('coming-soon', 'Contacts', 'nav-contacts')">
              <!-- person icon -->
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="6.5" cy="4" r="2.5"/>
                <path d="M1 12c0-3.038 2.462-5.5 5.5-5.5S12 8.962 12 12"/>
              </svg>
              Contacts
            </button>

            <button id="nav-tasks" class="nav-sub-item" onclick="navigate('coming-soon', 'Tasks', 'nav-tasks')">
              <!-- checklist icon -->
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <rect x="1.5" y="1.5" width="10" height="10" rx="1.5"/>
                <path d="M4 6.5L5.5 8L9 4.5"/>
              </svg>
              Tasks
            </button>
          </div>
        </div>

      </div>
    </nav>

    <!-- ── Main content area ─────────────────────────────────────────── -->
    <main style="flex: 1; display: flex; flex-direction: column; overflow: hidden; background: var(--bg);">

      <!-- Knowledge Graph view -->
      <div id="view-kg" style="height: 100%; display: flex; flex-direction: column;">

        <!-- Toolbar: search + status -->
        <div style="flex: none; display: flex; align-items: center; gap: 10px; padding: 10px 16px; border-bottom: 1px solid var(--border);">
          <input id="search-input" type="text" placeholder="Search nodes by label or properties…" style="max-width: 400px;" />
          <button id="search-btn" class="btn-primary">Search</button>
          <span id="status" style="font-size: 0.75rem; color: var(--fg-muted); margin-left: 4px;"></span>
        </div>

        <!-- Split: node list panel | graph canvas -->
        <div style="flex: 1; display: flex; overflow: hidden;">

          <!-- Node list -->
          <div style="flex: none; width: 240px; overflow-y: auto; padding: 12px; border-right: 1px solid var(--border);">
            <div style="font-size: 0.6875rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: var(--fg-muted); margin-bottom: 10px;">Nodes</div>
            <div id="results"></div>
          </div>

          <!-- Cytoscape graph -->
          <div style="flex: 1; position: relative; overflow: hidden;">
            <div id="cy"></div>
          </div>

        </div>
      </div>

      <!-- Coming Soon view (shared by Chat, Contacts, Tasks) -->
      <div id="view-coming-soon" style="display: none; height: 100%; flex-direction: column; align-items: center; justify-content: center;">
        <p style="font-size: 0.6875rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.15em; color: var(--fg-muted); margin: 0 0 8px;">Coming Soon</p>
        <h2 id="coming-soon-title" style="font-family: 'Lora', Georgia, serif; font-size: 2rem; font-weight: 500; color: var(--fg); margin: 0;"></h2>
      </div>

    </main>
  </div>

  <script src="/kg/assets/cytoscape.min.js"></script>
  <script>
    // ── State ──────────────────────────────────────────────────────────
    var cy = null;           // Cytoscape instance (lazy-initialised on first login)
    var memoryOpen = true;   // Memory nav section expanded by default
    var activeNavId = 'nav-kg';

    // ── Element refs ───────────────────────────────────────────────────
    var authWall      = document.getElementById('auth-wall');
    var mainApp       = document.getElementById('main-app');
    var authForm      = document.getElementById('auth-form');
    var authInput     = document.getElementById('auth-input');
    var authError     = document.getElementById('auth-error');
    var statusEl      = document.getElementById('status');
    var resultsEl     = document.getElementById('results');
    var searchInput   = document.getElementById('search-input');
    var searchBtn     = document.getElementById('search-btn');
    var memoryCaret   = document.getElementById('memory-chevron');
    var memorySubmenu = document.getElementById('memory-submenu');

    // Catch template/script divergence early rather than producing cryptic null errors
    if (!authWall || !mainApp || !authForm || !authInput || !authError ||
        !statusEl || !resultsEl || !searchInput || !searchBtn ||
        !memoryCaret || !memorySubmenu) {
      throw new Error('Curia KG: required DOM element missing — check template integrity.');
    }

    // ── Auth ───────────────────────────────────────────────────────────
    function getSecret() {
      return sessionStorage.getItem('web_app_bootstrap_secret') || '';
    }

    function showMain() {
      authWall.style.display = 'none';
      mainApp.style.display  = 'flex';
      initCytoscape();
      search(); // auto-load all nodes on entry
    }

    authForm.addEventListener('submit', function(e) {
      e.preventDefault();
      var secret = authInput.value.trim();
      if (!secret) return;

      var btn = authForm.querySelector('button[type="submit"]');
      btn.textContent = 'Checking\u2026';
      btn.disabled = true;
      authError.style.display = 'none';

      // Validate secret against the server before storing it — gives immediate
      // feedback if the key is wrong rather than letting errors surface in the search.
      fetch('/api/kg/nodes?limit=1', { headers: { 'x-web-bootstrap-secret': secret } })
        .then(function(res) {
          if (res.status === 401) {
            authError.style.display = 'block';
            btn.textContent = 'Enter';
            btn.disabled = false;
            return;
          }
          sessionStorage.setItem('web_app_bootstrap_secret', secret);
          showMain();
        })
        .catch(function() {
          // Network error — store and proceed; subsequent API calls will surface issues.
          sessionStorage.setItem('web_app_bootstrap_secret', secret);
          showMain();
        });
    });

    // Auto-unlock when a valid key is already stored in this session
    if (getSecret()) showMain();

    // ── Cytoscape ──────────────────────────────────────────────────────
    function initCytoscape() {
      if (cy) return;
      cy = cytoscape({
        container: document.getElementById('cy'),
        elements: [],
        style: [
          {
            selector: 'node',
            style: {
              label: 'data(label)',
              'background-color': '#4174C8',  // --chart-2
              color: '#FAFAFA',
              'text-valign': 'center',
              'text-halign': 'center',
              'font-size': 10,
              'font-family': 'Manrope, system-ui, sans-serif',
              width: 32,
              height: 32,
            },
          },
          { selector: 'node[type="person"]',       style: { 'background-color': '#478189' } }, // teal accent
          { selector: 'node[type="organization"]',  style: { 'background-color': '#6BAED6' } }, // --chart-1
          { selector: 'node[type="project"]',       style: { 'background-color': '#555555' } }, // --accent
          {
            selector: 'edge',
            style: {
              width: 1.5,
              'line-color': 'rgba(255,255,255,0.15)',
              'curve-style': 'bezier',
              'target-arrow-shape': 'triangle',
              'target-arrow-color': 'rgba(255,255,255,0.15)',
              label: 'data(label)',
              'font-size': 9,
              'font-family': 'Manrope, system-ui, sans-serif',
              color: '#ADADAD',
            },
          },
        ],
        layout: { name: 'cose', animate: false },
      });
    }

    // ── Navigation ─────────────────────────────────────────────────────
    function navigate(view, title, navId) {
      var kgView = document.getElementById('view-kg');
      var csView = document.getElementById('view-coming-soon');

      kgView.style.display = view === 'kg'           ? 'flex' : 'none';
      csView.style.display = view === 'coming-soon'  ? 'flex' : 'none';

      if (view === 'coming-soon') {
        document.getElementById('coming-soon-title').textContent = title;
      }

      // Update active highlight
      if (activeNavId) {
        var prev = document.getElementById(activeNavId);
        if (prev) prev.classList.remove('active');
      }
      if (navId) {
        var curr = document.getElementById(navId);
        if (curr) curr.classList.add('active');
        activeNavId = navId;
      }
    }

    function toggleMemory() {
      memoryOpen = !memoryOpen;
      memorySubmenu.style.display = memoryOpen ? 'flex' : 'none';
      memoryCaret.classList.toggle('collapsed', !memoryOpen);
    }

    // ── KG API helpers ─────────────────────────────────────────────────
    function setStatus(msg, isError) {
      statusEl.textContent = msg;
      statusEl.style.color = isError ? 'var(--destructive)' : 'var(--fg-muted)';
    }

    function fetchJson(url) {
      var secret = getSecret();
      var headers = secret ? { 'x-web-bootstrap-secret': secret } : {};
      return fetch(url, { headers: headers }).then(function(res) {
        if (!res.ok) return res.text().then(function(t) { throw new Error(t); });
        return res.json();
      });
    }

    function renderResults(nodes) {
      resultsEl.replaceChildren();
      if (nodes.length === 0) {
        var p = document.createElement('p');
        p.style.cssText = 'font-size: 0.8125rem; color: var(--fg-muted); margin: 0;';
        p.textContent = 'No matching nodes.';
        resultsEl.appendChild(p);
        return;
      }

      nodes.forEach(function(node) {
        var card = document.createElement('div');
        card.className = 'node-card';

        // Use textContent (not innerHTML) to prevent stored XSS — labels come from the DB
        // and could carry HTML/JS payloads injected through imported data sources.
        var label = document.createElement('div');
        label.style.cssText = 'font-size: 0.8125rem; font-weight: 600; color: var(--fg); margin-bottom: 2px;';
        label.textContent = node.label;

        var meta = document.createElement('div');
        meta.style.cssText = 'font-size: 0.75rem; color: var(--fg-muted);';
        meta.textContent = node.type + ' \u00B7 ' + node.confidence.toFixed(2);

        card.append(label, meta);
        card.addEventListener('click', function() { loadNeighborhood(node.id); });
        resultsEl.appendChild(card);
      });
    }

    function renderGraph(payload) {
      if (!cy) return;
      var elements = [].concat(
        payload.nodes.map(function(n) { return { data: { id: n.id, label: n.label, type: n.type } }; }),
        payload.edges.map(function(e) { return { data: { id: e.id, source: e.sourceNodeId, target: e.targetNodeId, label: e.type } }; })
      );
      cy.elements().remove();
      cy.add(elements);
      cy.layout({ name: 'cose', animate: false, fit: true }).run();
    }

    function search() {
      setStatus('Searching\u2026');
      var q = encodeURIComponent(searchInput.value.trim());
      fetchJson('/api/kg/nodes?query=' + q + '&limit=100')
        .then(function(data) {
          renderResults(data.nodes);
          setStatus(data.nodes.length + ' node' + (data.nodes.length === 1 ? '' : 's'));
        })
        .catch(function(err) { setStatus(String(err), true); });
    }

    function loadNeighborhood(nodeId) {
      setStatus('Loading\u2026');
      fetchJson('/api/kg/graph?node_id=' + encodeURIComponent(nodeId) + '&depth=2')
        .then(function(data) {
          renderGraph(data);
          setStatus(data.nodes.length + ' nodes \u00B7 ' + data.edges.length + ' edges');
        })
        .catch(function(err) { setStatus(String(err), true); });
    }

    searchBtn.addEventListener('click', search);
    searchInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') search(); });
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
