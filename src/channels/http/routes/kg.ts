import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { EventBus } from '../../../bus/bus.js';
import { createInboundMessage } from '../../../bus/events.js';
import type { Logger } from '../../../logger.js';
import { MessageRejectedError, type EventRouter } from '../event-router.js';

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

// Session token → expiry timestamp (ms). Scoped to the route registration
// lifetime (process lifetime for production). Single-tenant tool: memory is fine.
type SessionStore = Map<string, number>;

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
  sessions: SessionStore,
): boolean {
  if (!configuredSecret) {
    reply.status(503).send({
      error: 'Knowledge graph web UI is disabled. Set WEB_APP_BOOTSTRAP_SECRET in .env to enable it.',
    });
    return false;
  }

  // Primary path: browser session cookie set by POST /auth.
  // @fastify/cookie augments FastifyRequest with .cookies at runtime.
  const cookies = (request as unknown as { cookies?: Record<string, string | undefined> }).cookies;
  const sessionToken = cookies?.['curia_session'];
  if (sessionToken) {
    const expiresAt = sessions.get(sessionToken);
    if (expiresAt !== undefined && Date.now() < expiresAt) return true;
    // Expired or unknown token — fall through to header check below.
  }

  // Fallback: direct header (programmatic API access via curl / scripts).
  // Reject non-string values (Fastify coerces duplicate headers to string[]).
  // Use timing-safe comparison to prevent character-by-character brute force.
  const provided = request.headers['x-web-bootstrap-secret'];
  if (
    typeof provided !== 'string' ||
    provided.length !== configuredSecret.length ||
    !timingSafeEqual(Buffer.from(provided), Buffer.from(configuredSecret))
  ) {
    reply.status(401).send({
      error: 'Unauthorized. Authenticate via POST /auth or provide the x-web-bootstrap-secret header.',
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

    /* ── Chat view ───────────────────────────────────────────────────── */

    /* Sidebar: conversation list */
    .chat-sidebar {
      flex: none;
      width: 220px;
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    /* Thread column: messages + input bar */
    .chat-thread {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    /* Scrollable message area */
    .chat-messages {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    /* Input bar at the bottom of the thread */
    .chat-input-bar {
      flex: none;
      padding: 12px 16px;
      border-top: 1px solid var(--border);
      display: flex;
      align-items: flex-end;
      gap: 8px;
    }

    /* Resizable textarea */
    textarea.chat-textarea {
      flex: 1;
      resize: none;
      min-height: 56px;
      max-height: 120px;
      background: var(--muted);
      border: 1px solid var(--input-border);
      border-radius: var(--radius-md);
      color: var(--fg);
      font-family: inherit;
      font-size: 0.875rem;
      padding: 8px 12px;
      outline: none;
      transition: border-color 0.12s;
    }
    textarea.chat-textarea:focus { border-color: var(--teal); }

    /* Message bubbles */
    .msg-bubble {
      max-width: 80%;
      padding: 8px 12px;
      border-radius: var(--radius-lg);
      font-size: 0.875rem;
      line-height: 1.5;
      word-wrap: break-word;
      white-space: pre-wrap;
    }
    .msg-bubble.user {
      align-self: flex-end;
      background: var(--teal);
      color: var(--fg);
      border-bottom-right-radius: 2px;
    }
    .msg-bubble.agent {
      align-self: flex-start;
      background: var(--card);
      border: 1px solid var(--border);
      color: var(--fg);
      border-bottom-left-radius: 2px;
    }
    /* Status messages: skill.invoke notifications, "thinking…" indicator */
    .msg-bubble.status {
      align-self: center;
      background: none;
      color: var(--fg-muted);
      font-size: 0.75rem;
      font-style: italic;
      padding: 2px 8px;
      max-width: 100%;
    }
    .msg-bubble.error {
      align-self: flex-start;
      background: rgba(232,96,64,0.12);
      border: 1px solid rgba(232,96,64,0.30);
      color: var(--destructive);
      border-bottom-left-radius: 2px;
    }

    /* Conversation list items */
    .conv-item {
      padding: 7px 10px;
      border-radius: var(--radius-md);
      font-size: 0.8125rem;
      color: var(--fg-muted);
      cursor: pointer;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      transition: background 0.12s, color 0.12s;
    }
    .conv-item:hover  { background: var(--accent); color: var(--fg); }
    .conv-item.active { background: var(--muted);  color: var(--fg); }
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
        <button id="nav-chat" class="nav-item" onclick="navigate('chat', 'Chat', 'nav-chat')">
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

      <!-- Coming Soon view (shared by Contacts, Tasks) -->
      <div id="view-coming-soon" style="display: none; height: 100%; flex-direction: column; align-items: center; justify-content: center;">
        <p style="font-size: 0.6875rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.15em; color: var(--fg-muted); margin: 0 0 8px;">Coming Soon</p>
        <h2 id="coming-soon-title" style="font-family: 'Lora', Georgia, serif; font-size: 2rem; font-weight: 500; color: var(--fg); margin: 0;"></h2>
      </div>

      <!-- Chat view — hidden until user clicks the Chat nav item -->
      <div id="view-chat" style="display: none; height: 100%; flex-direction: row;">

        <!-- Left: conversation list -->
        <div class="chat-sidebar">
          <div style="padding: 10px 8px; border-bottom: 1px solid var(--border);">
            <button class="btn-primary" style="width: 100%;" onclick="newConversation()">+ New Chat</button>
          </div>
          <div id="chat-conv-list" style="flex: 1; overflow-y: auto; padding: 6px; display: flex; flex-direction: column; gap: 2px;"></div>
        </div>

        <!-- Right: message thread + input -->
        <div class="chat-thread">
          <div id="chat-messages" class="chat-messages"></div>
          <div class="chat-input-bar">
            <form id="chat-form" style="display: contents;">
              <textarea id="chat-textarea" class="chat-textarea" placeholder="Message Curia\u2026" rows="2"></textarea>
              <button type="submit" id="chat-send-btn" class="btn-primary" style="padding: 8px 16px;">Send</button>
            </form>
          </div>
        </div>

      </div>

    </main>
  </div>

  <script src="/assets/cytoscape.min.js"></script>
  <script>
    // ── State ──────────────────────────────────────────────────────────
    var cy = null;           // Cytoscape instance (lazy-initialised on first login)
    var memoryOpen = true;   // Memory nav section expanded by default
    var activeNavId = 'nav-kg';

    // ── Chat state ─────────────────────────────────────────────────────
    // Active EventSource for SSE — one per conversation, null when idle.
    var chatStream = null;
    // Active conversation UUID — set when the user sends their first message
    // in a new conversation, or when switching between past conversations.
    var chatConversationId = null;
    // Tracks whether the agent reply has been rendered for the current round-trip
    // to prevent the SSE outbound.message and the POST response from both appending
    // the same text (whichever fires first wins; the other is a no-op).
    var chatReplyRendered = false;
    // In-session conversation list. Each entry: { id, label, messages: [] }
    // where messages are { role: 'user'|'agent'|'status'|'error', text: string }.
    var chatConversations = [];
    // Index of the currently active conversation, or -1 if none.
    var chatActiveConvIdx = -1;

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

    // Chat DOM refs
    var chatMessagesEl = document.getElementById('chat-messages');
    var chatConvListEl = document.getElementById('chat-conv-list');
    var chatForm       = document.getElementById('chat-form');
    var chatTextarea   = document.getElementById('chat-textarea');
    var chatSendBtn    = document.getElementById('chat-send-btn');

    // Catch template/script divergence early rather than producing cryptic null errors
    if (!authWall || !mainApp || !authForm || !authInput || !authError ||
        !statusEl || !resultsEl || !searchInput || !searchBtn ||
        !memoryCaret || !memorySubmenu ||
        !chatMessagesEl || !chatConvListEl || !chatForm || !chatTextarea || !chatSendBtn) {
      throw new Error('Curia KG: required DOM element missing — check template integrity.');
    }

    // ── Auth ───────────────────────────────────────────────────────────
    // Session is maintained by an HttpOnly cookie set by POST /auth.
    // The secret never lives in JS-land after the exchange.

    function showMain() {
      authWall.style.display = 'none';
      mainApp.style.display  = 'flex';
      initCytoscape();
      search(); // auto-load all nodes on entry
    }

    function showAuthError(msg) {
      authError.textContent = msg || 'Invalid access key \u2014 please try again.';
      authError.style.display = 'block';
    }

    authForm.addEventListener('submit', function(e) {
      e.preventDefault();
      var secret = authInput.value.trim();
      if (!secret) return;

      var btn = authForm.querySelector('button[type="submit"]');
      btn.textContent = 'Checking\u2026';
      btn.disabled = true;
      authError.style.display = 'none';

      // Exchange the secret for an HttpOnly session cookie via POST /auth.
      // The secret travels in a JSON body (not a header or query string) and
      // is never stored in JS-accessible storage.
      fetch('/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: secret }),
      })
        .then(function(res) {
          if (res.status === 401) {
            showAuthError('Invalid access key \u2014 please try again.');
            btn.textContent = 'Enter';
            btn.disabled = false;
            return;
          }
          if (res.status === 429) {
            showAuthError('Too many attempts \u2014 please wait before trying again.');
            btn.textContent = 'Enter';
            btn.disabled = false;
            return;
          }
          // Cookie is now set by the server. Clear the input so the secret
          // doesn't linger in the DOM longer than necessary.
          authInput.value = '';
          showMain();
        })
        .catch(function() {
          // Network error — do not grant access. Show an error so the user can retry.
          showAuthError('Could not reach server \u2014 please check your connection and try again.');
          btn.textContent = 'Enter';
          btn.disabled = false;
        });
    });

    // On page load, probe the API to check whether a valid session cookie already
    // exists (e.g. page refresh within a live session). If so, skip the auth wall.
    fetch('/api/kg/nodes?limit=1')
      .then(function(res) { if (res.ok) showMain(); })
      .catch(function() { /* network error — stay on auth wall */ });

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
      var kgView   = document.getElementById('view-kg');
      var chatView = document.getElementById('view-chat');
      var csView   = document.getElementById('view-coming-soon');

      kgView.style.display   = view === 'kg'           ? 'flex' : 'none';
      chatView.style.display = view === 'chat'         ? 'flex' : 'none';
      csView.style.display   = view === 'coming-soon'  ? 'flex' : 'none';

      if (view === 'coming-soon') {
        document.getElementById('coming-soon-title').textContent = title;
      }

      // On first entry into the Chat view with no conversations yet, ensure
      // the thread panel is empty (defensive reset in case it has stale content).
      if (view === 'chat' && chatActiveConvIdx === -1 && chatConversations.length === 0) {
        // No conversations yet — show empty state, ready for first message.
        chatMessagesEl.replaceChildren();
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
      // No explicit auth header needed — the browser sends the HttpOnly session
      // cookie automatically with every same-origin request.
      return fetch(url).then(function(res) {
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

    // ── Chat ───────────────────────────────────────────────────────────

    // Appends a message bubble to the thread panel and scrolls to bottom.
    // Also persists the message to the in-memory conversation store so it
    // survives switching between conversations.
    // role: 'user' | 'agent' | 'status' | 'error'
    function renderMessage(role, text) {
      var bubble = document.createElement('div');
      bubble.className = 'msg-bubble ' + role;
      // textContent prevents stored XSS — messages come from the agent/user
      // and could include characters that look like HTML.
      bubble.textContent = text;
      chatMessagesEl.appendChild(bubble);
      chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;

      // Persist to current conversation store (skip ephemeral status messages).
      if (role !== 'status' && chatActiveConvIdx >= 0) {
        chatConversations[chatActiveConvIdx].messages.push({ role: role, text: text });
      }
    }

    // Opens an SSE stream for the given conversationId.
    // Closes any previously open stream first to avoid leaking connections.
    function openChatStream(convId) {
      if (chatStream) {
        chatStream.close();
        chatStream = null;
      }

      var url = '/api/kg/chat/stream?conversationId=' + encodeURIComponent(convId);
      chatStream = new EventSource(url);

      chatStream.onmessage = function(event) {
        var payload;
        try {
          payload = JSON.parse(event.data);
        } catch {
          // Malformed frame — ignore. The SSE spec allows comment frames (:ping)
          // which EventSource silently drops, but custom parsers might not.
          return;
        }

        if (payload.type === 'skill.invoke') {
          // Show a transient status bubble so the user knows work is in progress.
          var skillName = payload.skill || payload.skillId || 'skill';
          renderMessage('status', 'Using ' + skillName + '\u2026');
        } else if (payload.type === 'outbound.message') {
          // Agent reply arrived via SSE — render it only if the POST response
          // hasn't already rendered it (race: whichever fires first wins).
          if (!chatReplyRendered) {
            chatReplyRendered = true;
            var content = (typeof payload.content === 'string') ? payload.content
                        : (typeof payload.message === 'string') ? payload.message
                        : JSON.stringify(payload);
            renderMessage('agent', content);
            chatSendBtn.disabled = false;
          }
        }
        // skill.result: not rendered — it's internal bookkeeping for the agent layer.
      };

      chatStream.onerror = function() {
        // Network interruption — the browser will try to reconnect automatically.
        // Don't surface an error bubble here to avoid noise on transient drops.
      };
    }

    // Creates a new in-session conversation, resets the thread panel,
    // and updates the conversation list in the sidebar.
    function newConversation() {
      // Close the current SSE stream — a fresh one will open on the next send.
      if (chatStream) {
        chatStream.close();
        chatStream = null;
      }
      chatConversationId = null;
      chatActiveConvIdx = -1;
      chatReplyRendered = false;
      chatMessagesEl.replaceChildren();
    }

    // Renders the sidebar conversation list, highlighting the active entry.
    function renderConvList() {
      chatConvListEl.replaceChildren();
      chatConversations.forEach(function(conv, idx) {
        var item = document.createElement('div');
        item.className = 'conv-item' + (idx === chatActiveConvIdx ? ' active' : '');
        item.textContent = conv.label;
        item.title = conv.label;
        item.addEventListener('click', function() { switchConversation(idx); });
        chatConvListEl.appendChild(item);
      });
    }

    // Switches the active conversation: restores its messages in the thread panel
    // and reopens the SSE stream for that conversationId.
    function switchConversation(idx) {
      if (idx === chatActiveConvIdx) return;
      chatActiveConvIdx = idx;
      chatConversationId = chatConversations[idx].id;
      chatReplyRendered = false;

      // Restore message history for the selected conversation.
      chatMessagesEl.replaceChildren();
      chatConversations[idx].messages.forEach(function(msg) {
        var bubble = document.createElement('div');
        bubble.className = 'msg-bubble ' + msg.role;
        bubble.textContent = msg.text;
        chatMessagesEl.appendChild(bubble);
      });
      chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;

      // Reopen SSE for future messages in this conversation.
      openChatStream(chatConversationId);
      renderConvList();
    }

    // Handles the chat form submit: validates input, creates a conversation if needed,
    // sends the message, and renders the reply (via POST response or SSE, whichever fires first).
    function sendChatMessage(e) {
      e.preventDefault();
      var text = chatTextarea.value.trim();
      if (!text) return;
      chatTextarea.value = '';

      // First message in a new conversation — generate a conversationId and create
      // the conversation entry. crypto.randomUUID() is available in all modern browsers.
      if (!chatConversationId) {
        var newId = 'kg-web-' + crypto.randomUUID();
        chatConversationId = newId;
        // Truncate label to ~40 chars for the sidebar.
        var label = text.length > 40 ? text.slice(0, 40) + '\u2026' : text;
        chatConversations.push({ id: newId, label: label, messages: [] });
        chatActiveConvIdx = chatConversations.length - 1;
        renderConvList();
        // Open SSE for this conversation BEFORE posting so no events are missed.
        openChatStream(newId);
      }

      chatReplyRendered = false;
      renderMessage('user', text);
      chatSendBtn.disabled = true;

      var convId = chatConversationId;

      fetch('/api/kg/chat/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, conversationId: convId }),
      })
        .then(function(res) {
          return res.json().then(function(body) {
            // Surface structured backend errors (400/401/403/504/500 all return { error: "..." }).
            if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
            return body;
          });
        })
        .then(function(data) {
          // Render the reply unless the SSE outbound.message already did so.
          if (!chatReplyRendered) {
            chatReplyRendered = true;
            renderMessage('agent', data.reply);
          }
          chatSendBtn.disabled = false;
        })
        .catch(function(err) {
          renderMessage('error', err.message || 'Something went wrong. Please try again.');
          chatSendBtn.disabled = false;
        });
    }

    // Allow Shift+Enter for newlines; plain Enter submits the form.
    chatTextarea.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendChatMessage(e);
      }
    });

    chatForm.addEventListener('submit', sendChatMessage);
  </script>
</body>
</html>`;
}

export async function knowledgeGraphRoutes(
  app: FastifyInstance,
  options: KnowledgeGraphRouteOptions,
): Promise<void> {
  const { pool, logger, webAppBootstrapSecret, secureCookies, bus, eventRouter } = options;

  // In-memory session store: token → expiry timestamp (ms).
  // Single-tenant tool — no DB persistence needed; sessions reset on server restart.
  const sessions: SessionStore = new Map();

  // Prune expired sessions every minute so the Map doesn't grow unboundedly.
  const pruneInterval = setInterval(() => {
    const now = Date.now();
    for (const [token, expiresAt] of sessions) {
      if (now > expiresAt) sessions.delete(token);
    }
  }, 60_000);
  // Unref so the interval doesn't prevent process exit during tests.
  pruneInterval.unref();

  app.get('/', async (_request, reply) => {
    reply
      .type('text/html; charset=utf-8')
      // Prevent the page from being embedded in an iframe (clickjacking defence).
      .header('X-Frame-Options', 'DENY')
      // Stop browsers from MIME-sniffing the response away from text/html.
      .header('X-Content-Type-Options', 'nosniff')
      .send(createUiHtml());
  });

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

    if (
      provided.length !== webAppBootstrapSecret.length ||
      !timingSafeEqual(Buffer.from(provided), Buffer.from(webAppBootstrapSecret))
    ) {
      return reply.status(401).send({ error: 'Invalid access key.' });
    }

    // Issue a 256-bit random session token. The secret itself never goes in the cookie.
    const token = randomBytes(32).toString('hex');
    sessions.set(token, Date.now() + 24 * 60 * 60 * 1000); // expires in 24 hours

    reply.setCookie('curia_session', token, {
      httpOnly: true,
      secure: secureCookies,  // true in prod (https://), false for http://localhost
      sameSite: 'strict',
      path: '/',
      maxAge: 86400,          // 24 hours in seconds
    });

    return reply.status(200).send({ ok: true });
  });

  app.get('/assets/cytoscape.min.js', async (_request, reply) => {
    const cytoscapePath = fileURLToPath(
      new URL('../../../../node_modules/cytoscape/dist/cytoscape.min.js', import.meta.url),
    );
    const source = await readFile(cytoscapePath, 'utf8');
    // Long-lived cache — cytoscape is a pinned dependency; the version never
    // changes without a code change, so immutable caching is safe here.
    reply
      .type('application/javascript; charset=utf-8')
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      .send(source);
  });

  app.get('/api/kg/nodes', async (request, reply) => {
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
  app.post('/api/kg/chat/messages', async (request, reply) => {
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
      return reply.send({ reply: content, conversationId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, conversationId }, 'KG chat message handling failed');
      // instanceof check for rejection — string matching would silently break if the
      // error wording changes. Timeout still falls back to substring because the event
      // router doesn't expose a dedicated TimeoutError class.
      const isRejected = err instanceof MessageRejectedError;
      const isTimeout = message.includes('timeout') || message.includes('Timeout');
      const status = isRejected ? 403 : isTimeout ? 504 : 500;
      return reply.status(status).send({ error: message });
    }
  });

  /**
   * GET /api/kg/chat/stream — SSE stream of agent events for the KG web app.
   *
   * Streams outbound.message, skill.invoke, and skill.result events from the EventRouter,
   * optionally filtered by ?conversationId=xxx. Mirrors GET /api/messages/stream.
   */
  app.get('/api/kg/chat/stream', async (request, reply) => {
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
      } catch {
        clearInterval(heartbeat);
      }
    }, 30_000);

    request.raw.on('close', () => {
      clearInterval(heartbeat);
      cleanup();
    });
  });
}
