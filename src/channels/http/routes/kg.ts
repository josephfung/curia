import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { EventBus } from '../../../bus/bus.js';
import { createInboundMessage } from '../../../bus/events.js';
import type { Logger } from '../../../logger.js';
import type { ContactService } from '../../../contacts/contact-service.js';
import type { ContactStatus } from '../../../contacts/types.js';
import { MessageRejectedError, type EventRouter } from '../event-router.js';
import { assertSecret, type SessionStore } from '../session-auth.js';

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
    /* Use absolute positioning so #cy fills its position:relative parent
       regardless of whether the flex chain gives the parent a definite height.
       height:100% on a flex-item child is unreliable across browsers. */
    #cy { position: absolute; top: 0; left: 0; right: 0; bottom: 0; }

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

    /* Contacts view */
    .contacts-layout {
      flex: 1;
      display: flex;
      overflow: hidden;
    }
    .contacts-list-panel {
      flex: none;
      width: 360px;
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .contacts-list {
      flex: 1;
      overflow-y: auto;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .contact-card {
      padding: 10px;
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      cursor: pointer;
      transition: border-color 0.12s, background 0.12s;
    }
    .contact-card:hover { border-color: var(--teal); }
    .contact-card.active {
      border-color: var(--teal);
      background: rgba(71,129,137,0.08);
    }
    .contacts-editor {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .tasks-layout {
      flex: 1;
      display: flex;
      overflow: hidden;
    }
    .tasks-list-panel {
      flex: none;
      width: 380px;
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .tasks-list {
      flex: 1;
      overflow-y: auto;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .task-card {
      padding: 10px;
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      cursor: pointer;
      transition: border-color 0.12s, background 0.12s;
    }
    .task-card:hover { border-color: var(--teal); }
    .task-card.active {
      border-color: var(--teal);
      background: rgba(71,129,137,0.08);
    }
    .tasks-editor {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .jobs-layout {
      flex: 1;
      display: flex;
      overflow: hidden;
    }
    .jobs-list-panel {
      flex: none;
      width: 380px;
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .jobs-list {
      flex: 1;
      overflow-y: auto;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .job-card {
      padding: 10px;
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      cursor: pointer;
      transition: border-color 0.12s, background 0.12s;
    }
    .job-card:hover { border-color: var(--teal); }
    .job-card.active {
      border-color: var(--teal);
      background: rgba(71,129,137,0.08);
    }
    .jobs-editor {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .form-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .form-field {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .form-field label {
      font-size: 0.75rem;
      color: var(--fg-muted);
    }
    .form-field textarea,
    .form-field select {
      background: var(--muted);
      border: 1px solid var(--input-border);
      border-radius: var(--radius-md);
      color: var(--fg);
      font-family: inherit;
      font-size: 0.875rem;
      padding: 8px 12px;
      outline: none;
      width: 100%;
    }
    .form-field textarea:focus,
    .form-field select:focus {
      border-color: var(--teal);
    }
    /* ── Wizard overlay ─────────────────────────────────────────────── */
    #view-wizard {
      position: fixed;
      inset: 0;
      z-index: 60;
      background: var(--bg);
      display: none;
      flex-direction: column;
      overflow: hidden;
    }
    .wizard-topbar {
      flex: none;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 24px;
      border-bottom: 1px solid var(--border);
    }
    .wizard-body {
      flex: 1;
      overflow-y: auto;
      padding: 32px 24px 40px;
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .wizard-content {
      width: 100%;
      max-width: 520px;
      display: flex;
      flex-direction: column;
    }
    .wizard-heading {
      font-family: 'Lora', Georgia, serif;
      font-size: 1.375rem;
      font-weight: 500;
      color: var(--fg);
      margin-bottom: 6px;
    }
    .wizard-subheading {
      font-size: 0.8125rem;
      color: var(--fg-muted);
      margin-bottom: 28px;
    }
    .wizard-label {
      font-size: 0.6875rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--fg-muted);
      margin-bottom: 10px;
    }
    .wizard-field { margin-bottom: 20px; }
    .wizard-field label {
      display: block;
      font-size: 0.8125rem;
      font-weight: 500;
      color: var(--fg-muted);
      margin-bottom: 6px;
    }
    .wizard-field input {
      background: var(--muted);
      border: 1px solid var(--input-border);
      border-radius: var(--radius-md);
      color: var(--fg);
      font-family: inherit;
      font-size: 0.875rem;
      padding: 10px 12px;
      outline: none;
      width: 100%;
      transition: border-color 0.12s;
    }
    .wizard-field input:focus { border-color: var(--teal); }
    .wizard-field textarea {
      background: var(--muted);
      border: 1px solid var(--input-border);
      border-radius: var(--radius-md);
      color: var(--fg);
      font-family: inherit;
      font-size: 0.875rem;
      padding: 10px 12px;
      outline: none;
      width: 100%;
      resize: vertical;
      min-height: 90px;
      transition: border-color 0.12s;
    }
    .wizard-field textarea:focus { border-color: var(--teal); }
    .wizard-progress { display: flex; gap: 6px; align-items: center; }
    .wizard-dot {
      width: 28px;
      height: 4px;
      border-radius: 2px;
      background: var(--muted);
      transition: background 0.2s;
    }
    .wizard-dot.done { background: var(--primary); }
    .tone-pill {
      padding: 6px 14px;
      border-radius: 99px;
      border: 1px solid var(--accent);
      background: none;
      color: var(--fg-muted);
      font-family: inherit;
      font-size: 0.8125rem;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.1s, color 0.1s, border-color 0.1s, opacity 0.1s;
    }
    .tone-pill.selected {
      background: var(--primary);
      color: var(--primary-fg);
      border-color: var(--primary);
    }
    .tone-pill.disabled { opacity: 0.35; cursor: not-allowed; pointer-events: none; }
    .wizard-preview {
      font-size: 0.8125rem;
      color: var(--teal);
      min-height: 18px;
      margin-bottom: 24px;
    }
    .wizard-sample {
      font-size: 0.8125rem;
      font-style: italic;
      color: var(--fg-muted);
      padding: 10px 14px;
      background: var(--card);
      border-radius: var(--radius-md);
      border-left: 2px solid var(--muted);
      margin-bottom: 24px;
    }
    .slider-labels {
      display: flex;
      justify-content: space-between;
      font-size: 0.6875rem;
      color: var(--accent);
      margin-bottom: 8px;
    }
    .posture-grid { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 28px; }
    .posture-card {
      flex: 1;
      min-width: 120px;
      padding: 12px 14px;
      border-radius: var(--radius-md);
      border: 1px solid var(--muted);
      background: none;
      color: var(--fg-muted);
      font-family: inherit;
      text-align: left;
      cursor: pointer;
      transition: border-color 0.12s, background 0.12s;
    }
    .posture-card:hover { border-color: var(--accent); }
    .posture-card.selected {
      border-color: var(--primary);
      background: rgba(222,222,222,0.06);
      color: var(--fg);
    }
    .posture-card-title { font-size: 0.8125rem; font-weight: 600; margin-bottom: 3px; }
    .posture-card-desc  { font-size: 0.75rem; }
    .review-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 20px;
      margin-bottom: 28px;
    }
    .review-row {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 10px 0;
      border-bottom: 1px solid var(--border);
    }
    .review-row:last-child { border-bottom: none; }
    .review-row-label {
      font-size: 0.6875rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--fg-muted);
    }
    .review-row-value { font-size: 0.875rem; color: var(--fg); }
    .wizard-nav {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      margin-top: 8px;
    }
    .btn-wizard-back {
      padding: 10px 20px;
      border-radius: var(--radius-md);
      border: 1px solid var(--muted);
      background: none;
      color: var(--fg-muted);
      font-family: inherit;
      font-size: 0.875rem;
      cursor: pointer;
      transition: border-color 0.12s, color 0.12s;
    }
    .btn-wizard-back:hover { border-color: var(--accent); color: var(--fg); }
    .btn-wizard-next {
      padding: 10px 24px;
      border-radius: var(--radius-md);
      background: var(--primary);
      color: var(--primary-fg);
      font-family: inherit;
      font-size: 0.875rem;
      font-weight: 600;
      border: none;
      cursor: pointer;
      transition: opacity 0.12s;
    }
    .btn-wizard-next:hover    { opacity: 0.88; }
    .btn-wizard-next:disabled { opacity: 0.5; cursor: not-allowed; }
    #chat-success-banner {
      display: none;
      background: rgba(71,129,137,0.15);
      border-bottom: 1px solid rgba(71,129,137,0.35);
      color: var(--teal);
      font-size: 0.8125rem;
      font-weight: 500;
      padding: 10px 16px;
      text-align: center;
      flex: none;
    }
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

            <button id="nav-contacts" class="nav-sub-item" onclick="navigate('contacts', 'Contacts', 'nav-contacts')">
              <!-- person icon -->
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="6.5" cy="4" r="2.5"/>
                <path d="M1 12c0-3.038 2.462-5.5 5.5-5.5S12 8.962 12 12"/>
              </svg>
              Contacts
            </button>

            <button id="nav-tasks" class="nav-sub-item" onclick="navigate('tasks', 'Tasks', 'nav-tasks')">
              <!-- checklist icon -->
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <rect x="1.5" y="1.5" width="10" height="10" rx="1.5"/>
                <path d="M4 6.5L5.5 8L9 4.5"/>
              </svg>
              Tasks
            </button>

            <button id="nav-scheduled-jobs" class="nav-sub-item" onclick="navigate('scheduled-jobs', 'Scheduled Jobs', 'nav-scheduled-jobs')">
              <!-- clock icon -->
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="6.5" cy="6.5" r="5"/>
                <path d="M6.5 3.75v3.15l2 1.25"/>
              </svg>
              Scheduled Jobs
            </button>
          </div>
        </div>

        <!-- Settings (expandable section) -->
        <div>
          <button class="nav-item" id="settings-toggle" onclick="toggleSettings()">
            <!-- gear icon -->
            <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="7.5" cy="7.5" r="2"/>
              <path d="M7.5 1v1.5M7.5 12.5V14M14 7.5h-1.5M2.5 7.5H1M12.07 2.93l-1.06 1.06M4 11l-1.06 1.06M12.07 12.07l-1.06-1.06M4 4l-1.06-1.06"/>
            </svg>
            Settings
            <svg id="settings-chevron" class="chevron" style="margin-left: auto;" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 4.5L6 7.5L9 4.5"/>
            </svg>
          </button>

          <div id="settings-submenu" style="display: flex; flex-direction: column; gap: 2px; margin-top: 2px;">
            <button id="nav-wizard" class="nav-sub-item" onclick="navigate('wizard', 'Setup Wizard', 'nav-wizard')">
              <!-- wand icon -->
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M2 11L8 5"/>
                <path d="M9.5 1.5l.5.5-.5.5-.5-.5z"/>
                <path d="M5.5 2.5l.5.5-.5.5-.5-.5z"/>
                <path d="M10.5 5.5l.5.5-.5.5-.5-.5z"/>
                <path d="M8 5l3.5-3.5"/>
              </svg>
              Setup Wizard
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

      <!-- Contacts view -->
      <div id="view-contacts" style="display: none; height: 100%; flex-direction: column;">
        <div style="flex: none; display: flex; align-items: center; gap: 10px; padding: 10px 16px; border-bottom: 1px solid var(--border);">
          <input id="contacts-search-input" type="text" placeholder="Search contacts by name or role\u2026" style="max-width: 360px;" />
          <button id="contacts-search-btn" class="btn-primary">Search</button>
          <button id="contacts-new-btn" class="btn-primary">+ New Contact</button>
          <span id="contacts-status" style="font-size: 0.75rem; color: var(--fg-muted); margin-left: 4px;"></span>
        </div>
        <div class="contacts-layout">
          <div class="contacts-list-panel">
            <div style="padding: 10px 12px 0; font-size: 0.6875rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: var(--fg-muted);">Contacts</div>
            <div id="contacts-list" class="contacts-list"></div>
          </div>
          <div class="contacts-editor">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <h2 id="contacts-editor-title" style="font-family: 'Lora', Georgia, serif; font-size: 1.375rem; font-weight: 500; margin: 0;">Create Contact</h2>
              <button id="contacts-delete-btn" class="btn-primary" style="display: none; background: var(--destructive); color: var(--fg);">Delete</button>
            </div>

            <form id="contacts-form" style="display: flex; flex-direction: column; gap: 12px; max-width: 720px;">
              <div class="form-grid">
                <div class="form-field">
                  <label for="contact-display-name">Display name</label>
                  <input id="contact-display-name" type="text" placeholder="e.g. Ada Lovelace" required />
                </div>
                <div class="form-field">
                  <label for="contact-role">Role</label>
                  <input id="contact-role" type="text" placeholder="e.g. CTO" />
                </div>
                <div class="form-field">
                  <label for="contact-status">Status</label>
                  <select id="contact-status">
                    <option value="confirmed">confirmed</option>
                    <option value="provisional">provisional</option>
                    <option value="blocked">blocked</option>
                  </select>
                </div>
                <div class="form-field">
                  <label for="contact-kg-node-id">KG node ID (optional)</label>
                  <input id="contact-kg-node-id" type="text" placeholder="UUID (optional)" />
                </div>
              </div>
              <div class="form-field">
                <label for="contact-notes">Notes</label>
                <textarea id="contact-notes" rows="4" placeholder="Notes about this contact\u2026"></textarea>
              </div>
              <div style="display: flex; gap: 10px;">
                <button type="submit" id="contacts-save-btn" class="btn-primary">Create Contact</button>
                <button type="button" id="contacts-cancel-btn" class="btn-primary" style="background: var(--muted); color: var(--fg);">Cancel</button>
              </div>
            </form>
          </div>
        </div>
      </div>

      <!-- Agent Tasks view -->
      <div id="view-tasks" style="display: none; height: 100%; flex-direction: column;">
        <div style="flex: none; display: flex; align-items: center; gap: 10px; padding: 10px 16px; border-bottom: 1px solid var(--border);">
          <input id="tasks-search-input" type="text" placeholder="Search agent tasks by agent, intent, or status…" style="max-width: 420px;" />
          <button id="tasks-search-btn" class="btn-primary">Search</button>
          <button id="tasks-new-btn" class="btn-primary">+ New Agent Task</button>
          <span id="tasks-status" style="font-size: 0.75rem; color: var(--fg-muted); margin-left: 4px;"></span>
        </div>
        <div class="tasks-layout">
          <div class="tasks-list-panel">
            <div style="padding: 10px 12px 0; font-size: 0.6875rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: var(--fg-muted);">Agent Tasks</div>
            <div id="tasks-list" class="tasks-list"></div>
          </div>
          <div class="tasks-editor">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <h2 id="tasks-editor-title" style="font-family: 'Lora', Georgia, serif; font-size: 1.375rem; font-weight: 500; margin: 0;">Create Agent Task</h2>
              <button id="tasks-delete-btn" class="btn-primary" style="display: none; background: var(--destructive); color: var(--fg);">Delete</button>
            </div>

            <form id="tasks-form" style="display: flex; flex-direction: column; gap: 12px; max-width: 900px;">
              <div class="form-grid">
                <div class="form-field">
                  <label for="task-agent-id">Agent ID</label>
                  <input id="task-agent-id" type="text" placeholder="e.g. coordinator" required />
                </div>
                <div class="form-field">
                  <label for="task-status">Status</label>
                  <select id="task-status">
                    <option value="active">active</option>
                    <option value="pending">pending</option>
                    <option value="paused">paused</option>
                    <option value="completed">completed</option>
                    <option value="failed">failed</option>
                    <option value="cancelled">cancelled</option>
                  </select>
                </div>
              </div>
              <div class="form-field">
                <label for="task-intent-anchor">Intent anchor</label>
                <textarea id="task-intent-anchor" rows="2" placeholder="Persistent task goal/context..." required></textarea>
              </div>
              <div class="form-grid">
                <div class="form-field">
                  <label for="task-conversation-id">Conversation ID (optional UUID)</label>
                  <input id="task-conversation-id" type="text" placeholder="UUID (optional)" />
                </div>
                <div class="form-field">
                  <label for="task-scheduled-job-id">Scheduled Job ID (optional UUID)</label>
                  <input id="task-scheduled-job-id" type="text" placeholder="UUID (optional)" />
                </div>
              </div>
              <div class="form-field">
                <label for="task-error-budget">Error budget JSON</label>
                <textarea id="task-error-budget" rows="4" placeholder='{"maxTurns": 12, "maxConsecutiveErrors": 3}'></textarea>
              </div>
              <div class="form-field">
                <label for="task-progress">Progress JSON</label>
                <textarea id="task-progress" rows="5" placeholder='{"phase":"initializing"}'></textarea>
              </div>
              <div style="display: flex; gap: 10px;">
                <button type="submit" id="tasks-save-btn" class="btn-primary">Create Agent Task</button>
                <button type="button" id="tasks-cancel-btn" class="btn-primary" style="background: var(--muted); color: var(--fg);">Cancel</button>
              </div>
            </form>
          </div>
        </div>
      </div>

      <!-- Scheduled Jobs view -->
      <div id="view-scheduled-jobs" style="display: none; height: 100%; flex-direction: column;">
        <div style="flex: none; display: flex; align-items: center; gap: 10px; padding: 10px 16px; border-bottom: 1px solid var(--border);">
          <input id="jobs-search-input" type="text" placeholder="Search jobs by agent, status, cron, or intent…" style="max-width: 420px;" />
          <button id="jobs-search-btn" class="btn-primary">Search</button>
          <button id="jobs-new-btn" class="btn-primary">+ New Scheduled Job</button>
          <span id="jobs-status" style="font-size: 0.75rem; color: var(--fg-muted); margin-left: 4px;"></span>
        </div>
        <div class="jobs-layout">
          <div class="jobs-list-panel">
            <div style="padding: 10px 12px 0; font-size: 0.6875rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: var(--fg-muted);">Scheduled Jobs</div>
            <div id="jobs-list" class="jobs-list"></div>
          </div>
          <div class="jobs-editor">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <h2 id="jobs-editor-title" style="font-family: 'Lora', Georgia, serif; font-size: 1.375rem; font-weight: 500; margin: 0;">Create Scheduled Job</h2>
              <button id="jobs-delete-btn" class="btn-primary" style="display: none; background: var(--destructive); color: var(--fg);">Delete</button>
            </div>

            <form id="jobs-form" style="display: flex; flex-direction: column; gap: 12px; max-width: 900px;">
              <div class="form-grid">
                <div class="form-field">
                  <label for="job-agent-id">Agent ID</label>
                  <input id="job-agent-id" type="text" placeholder="e.g. coordinator" required />
                </div>
                <div class="form-field">
                  <label for="job-status">Status</label>
                  <select id="job-status">
                    <option value="pending">pending</option>
                    <option value="running">running</option>
                    <option value="suspended">suspended</option>
                    <option value="completed">completed</option>
                    <option value="cancelled">cancelled</option>
                    <option value="failed">failed</option>
                  </select>
                </div>
              </div>
              <div class="form-grid">
                <div class="form-field">
                  <label for="job-cron-expr">Cron expression (optional)</label>
                  <input id="job-cron-expr" type="text" placeholder="e.g. 0 8 * * 1-5" />
                </div>
                <div class="form-field">
                  <label for="job-run-at">Run at (ISO-8601, optional)</label>
                  <input id="job-run-at" type="text" placeholder="e.g. 2026-04-20T15:00:00Z" />
                </div>
              </div>
              <div class="form-field">
                <label for="job-intent-anchor">Intent anchor (optional — creates linked agent task)</label>
                <textarea id="job-intent-anchor" rows="2" placeholder="Persistent intent for linked task..."></textarea>
              </div>
              <div class="form-field">
                <label for="job-task-payload">Task payload JSON</label>
                <textarea id="job-task-payload" rows="6" placeholder='{"kind":"follow_up","args":{"topic":"status update"}}' required></textarea>
              </div>
              <div style="display: flex; gap: 10px;">
                <button type="submit" id="jobs-save-btn" class="btn-primary">Create Scheduled Job</button>
                <button type="button" id="jobs-cancel-btn" class="btn-primary" style="background: var(--muted); color: var(--fg);">Cancel</button>
              </div>
            </form>
          </div>
        </div>
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
          <!-- Success banner — shown briefly after wizard completes -->
          <div id="chat-success-banner">Your assistant is ready.</div>
          <div id="chat-messages" class="chat-messages"></div>
          <div class="chat-input-bar">
            <form id="chat-form" style="display: contents;">
              <textarea id="chat-textarea" class="chat-textarea" placeholder="Message Curia\u2026" rows="2"></textarea>
              <button type="submit" id="chat-send-btn" class="btn-primary" style="padding: 8px 16px;">Send</button>
            </form>
          </div>
        </div>

      </div>

      <!-- ============================================================
           WIZARD OVERLAY — full-screen, z-index 60.
           Shown on first run (configured: false) or via Settings nav.
      ============================================================= -->
      <div id="view-wizard">

        <!-- Top bar: wordmark + progress dots + step counter -->
        <div class="wizard-topbar">
          <span style="font-family: 'Lora', Georgia, serif; font-size: 1.125rem; font-weight: 500; letter-spacing: 0.06em; color: var(--fg);">CURIA</span>
          <div class="wizard-progress">
            <div class="wizard-dot" id="wdot-1"></div>
            <div class="wizard-dot" id="wdot-2"></div>
            <div class="wizard-dot" id="wdot-3"></div>
            <div class="wizard-dot" id="wdot-4"></div>
          </div>
          <span id="wizard-step-label" style="font-size: 0.75rem; color: var(--fg-muted);">Step 1 of 4</span>
        </div>

        <div class="wizard-body">

          <!-- Step 1 — Name your assistant -->
          <div id="wstep-1" class="wizard-content" style="display: none;">
            <div class="wizard-heading">What should your assistant be called?</div>
            <div class="wizard-subheading">You can change these at any time from Settings.</div>
            <div class="wizard-field">
              <label for="w-name">Assistant name</label>
              <input id="w-name" type="text" placeholder="Alex Curia" />
            </div>
            <div class="wizard-field">
              <label for="w-title">Title</label>
              <input id="w-title" type="text" placeholder="Executive Assistant to the CEO" />
            </div>
            <div class="wizard-field">
              <label for="w-signature">Email signature <span style="font-weight:400;color:var(--fg-muted);">(optional)</span></label>
              <textarea id="w-signature" placeholder="Alex Curia&#10;Office of the CEO"></textarea>
            </div>
            <div id="wstep1-error" style="display:none;color:var(--destructive);font-size:0.8125rem;margin-bottom:12px;"></div>
            <div class="wizard-nav">
              <span></span>
              <button class="btn-wizard-next" onclick="wizardNext()">Next →</button>
            </div>
          </div>

          <!-- Step 2 — Communication style -->
          <div id="wstep-2" class="wizard-content" style="display: none;">
            <div class="wizard-heading">How should your assistant communicate?</div>
            <div class="wizard-subheading">Pick 1–3 words that describe the tone you want.</div>
            <div class="wizard-label">Tone <span style="font-weight:400;text-transform:none;letter-spacing:0;">(pick up to 3)</span></div>
            <div id="tone-pill-grid" style="display:flex;flex-wrap:wrap;gap:7px;margin-bottom:10px;"></div>
            <div id="tone-preview" class="wizard-preview"></div>
            <div class="wizard-label" style="margin-top:4px;">Detail level</div>
            <input id="w-verbosity" type="range" min="0" max="100" value="50"
              style="width:100%;accent-color:var(--primary);margin-bottom:6px;" oninput="updateVerbosityPreview()" />
            <div class="slider-labels"><span>Brief</span><span>Thorough</span></div>
            <div id="verbosity-preview" class="wizard-sample"></div>
            <div class="wizard-label">Directness</div>
            <input id="w-directness" type="range" min="0" max="100" value="75"
              style="width:100%;accent-color:var(--primary);margin-bottom:6px;" oninput="updateDirectnessPreview()" />
            <div class="slider-labels"><span>Measured</span><span>Direct</span></div>
            <div id="directness-preview" class="wizard-sample"></div>
            <div class="wizard-label">Decision posture <span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--accent);">(for external actions)</span></div>
            <div class="posture-grid">
              <button class="posture-card" data-posture="conservative" onclick="selectPosture('conservative')">
                <div class="posture-card-title">Conservative</div>
                <div class="posture-card-desc">Verify before acting; flag ambiguity</div>
              </button>
              <button class="posture-card" data-posture="balanced" onclick="selectPosture('balanced')">
                <div class="posture-card-title">Balanced</div>
                <div class="posture-card-desc">Act when confident, flag when uncertain</div>
              </button>
              <button class="posture-card" data-posture="proactive" onclick="selectPosture('proactive')">
                <div class="posture-card-title">Proactive</div>
                <div class="posture-card-desc">Bias toward action; less checking in</div>
              </button>
            </div>
            <div class="wizard-nav">
              <button class="btn-wizard-back" onclick="wizardBack()">← Back</button>
              <button class="btn-wizard-next" onclick="wizardNext()">Next →</button>
            </div>
          </div>

          <!-- Step 3 — Anything else? -->
          <div id="wstep-3" class="wizard-content" style="display: none;">
            <div class="wizard-heading">Is there anything else we should know?</div>
            <div class="wizard-subheading">Optional — any specific preferences you'd like your assistant to follow.</div>
            <div class="wizard-field">
              <textarea id="w-preferences" style="min-height:140px;"
                placeholder="E.g., 'Always include agenda items in meeting requests' or 'Flag emails from investors as high priority'"></textarea>
            </div>
            <div class="wizard-nav">
              <button class="btn-wizard-back" onclick="wizardBack()">← Back</button>
              <button class="btn-wizard-next" onclick="wizardNext()">Review →</button>
            </div>
          </div>

          <!-- Step 4 — Review & confirm -->
          <div id="wstep-4" class="wizard-content" style="display: none;">
            <div class="wizard-heading">Does everything look right?</div>
            <div class="wizard-subheading">Go back to change anything, or save to get started.</div>
            <div class="review-card" id="review-card"></div>
            <div id="wizard-error" style="display:none;color:var(--destructive);font-size:0.8125rem;margin-bottom:12px;"></div>
            <div class="wizard-nav">
              <button class="btn-wizard-back" onclick="wizardBack()">← Back</button>
              <button id="wizard-save-btn" class="btn-wizard-next" onclick="submitWizard()">Confirm &amp; save</button>
            </div>
          </div>

        </div><!-- /.wizard-body -->
      </div><!-- /#view-wizard -->

    </main>
  </div>

  <script src="/assets/cytoscape.min.js"></script>
  <!-- fcose layout extension: load dependency chain in order before registering the plugin -->
  <script src="/assets/layout-base.js"></script>
  <script src="/assets/cose-base.js"></script>
  <script src="/assets/cytoscape-fcose.js"></script>
  <script>
    // ── State ──────────────────────────────────────────────────────────
    var cy = null;           // Cytoscape instance (lazy-initialised on first login)
    var memoryOpen = true;   // Memory nav section expanded by default
    var settingsOpen = true; // Settings nav section expanded by default

    // ── Wizard state ───────────────────────────────────────────────────
    var wizardState = {
      step: 1,
      name: '',
      title: '',
      signature: '',
      toneBaseline: ['warm', 'direct'],
      verbosity: 50,
      directness: 75,
      posture: 'conservative',
      preferences: '',
    };

    // All valid tone words — mirrors BASELINE_TONE_OPTIONS in src/identity/types.ts.
    var TONE_OPTIONS = [
      'warm','friendly','approachable','personable','empathetic','encouraging','gracious','caring',
      'direct','blunt','candid','frank','matter-of-fact','no-nonsense',
      'energetic','calm','composed','enthusiastic','steady','measured',
      'playful','witty','dry','charming','diplomatic','tactful','thoughtful','curious',
      'confident','assured','polished','authoritative','professional',
    ];

    var activeNavId = 'nav-kg';
    var contacts = [];
    var selectedContactId = null;
    var contactsMode = 'create';
    var tasks = [];
    var selectedTaskId = null;
    var tasksMode = 'create';
    var jobs = [];
    var selectedJobId = null;
    var jobsMode = 'create';

    // ── Chat state ─────────────────────────────────────────────────────
    // Active EventSource for SSE — one per conversation, null when idle.
    var chatStream = null;
    // Active conversation UUID — set when the user sends their first message
    // in a new conversation, or when switching between past conversations.
    var chatConversationId = null;
    // Tracks which conversationIds have had their agent reply rendered this round-trip,
    // preventing both the SSE 'message' event and the POST response from appending the
    // same text (whichever fires first wins; the other is a no-op).
    // Keyed by conversationId so the guard is correctly scoped even when the user
    // switches conversations while a POST is in-flight.
    var chatRepliesDelivered = new Set();
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
    var settingsSubmenu = document.getElementById('settings-submenu');
    var settingsCaret   = document.getElementById('settings-chevron');
    var contactsStatusEl = document.getElementById('contacts-status');
    var contactsSearchInput = document.getElementById('contacts-search-input');
    var contactsSearchBtn = document.getElementById('contacts-search-btn');
    var contactsNewBtn = document.getElementById('contacts-new-btn');
    var contactsListEl = document.getElementById('contacts-list');
    var contactsForm = document.getElementById('contacts-form');
    var contactsEditorTitle = document.getElementById('contacts-editor-title');
    var contactsDeleteBtn = document.getElementById('contacts-delete-btn');
    var contactsSaveBtn = document.getElementById('contacts-save-btn');
    var contactsCancelBtn = document.getElementById('contacts-cancel-btn');
    var contactDisplayNameInput = document.getElementById('contact-display-name');
    var contactRoleInput = document.getElementById('contact-role');
    var contactStatusInput = document.getElementById('contact-status');
    var contactKgNodeIdInput = document.getElementById('contact-kg-node-id');
    var contactNotesInput = document.getElementById('contact-notes');
    var tasksStatusEl = document.getElementById('tasks-status');
    var tasksSearchInput = document.getElementById('tasks-search-input');
    var tasksSearchBtn = document.getElementById('tasks-search-btn');
    var tasksNewBtn = document.getElementById('tasks-new-btn');
    var tasksListEl = document.getElementById('tasks-list');
    var tasksForm = document.getElementById('tasks-form');
    var tasksEditorTitle = document.getElementById('tasks-editor-title');
    var tasksDeleteBtn = document.getElementById('tasks-delete-btn');
    var tasksSaveBtn = document.getElementById('tasks-save-btn');
    var tasksCancelBtn = document.getElementById('tasks-cancel-btn');
    var taskAgentIdInput = document.getElementById('task-agent-id');
    var taskStatusInput = document.getElementById('task-status');
    var taskIntentAnchorInput = document.getElementById('task-intent-anchor');
    var taskConversationIdInput = document.getElementById('task-conversation-id');
    var taskScheduledJobIdInput = document.getElementById('task-scheduled-job-id');
    var taskErrorBudgetInput = document.getElementById('task-error-budget');
    var taskProgressInput = document.getElementById('task-progress');
    var jobsStatusEl = document.getElementById('jobs-status');
    var jobsSearchInput = document.getElementById('jobs-search-input');
    var jobsSearchBtn = document.getElementById('jobs-search-btn');
    var jobsNewBtn = document.getElementById('jobs-new-btn');
    var jobsListEl = document.getElementById('jobs-list');
    var jobsForm = document.getElementById('jobs-form');
    var jobsEditorTitle = document.getElementById('jobs-editor-title');
    var jobsDeleteBtn = document.getElementById('jobs-delete-btn');
    var jobsSaveBtn = document.getElementById('jobs-save-btn');
    var jobsCancelBtn = document.getElementById('jobs-cancel-btn');
    var jobAgentIdInput = document.getElementById('job-agent-id');
    var jobStatusInput = document.getElementById('job-status');
    var jobCronExprInput = document.getElementById('job-cron-expr');
    var jobRunAtInput = document.getElementById('job-run-at');
    var jobIntentAnchorInput = document.getElementById('job-intent-anchor');
    var jobTaskPayloadInput = document.getElementById('job-task-payload');

    // Chat DOM refs
    var chatMessagesEl = document.getElementById('chat-messages');
    var chatConvListEl = document.getElementById('chat-conv-list');
    var chatForm       = document.getElementById('chat-form');
    var chatTextarea   = document.getElementById('chat-textarea');
    var chatSendBtn    = document.getElementById('chat-send-btn');

    // Wizard DOM refs
    var wstep1El         = document.getElementById('wstep-1');
    var wstep2El         = document.getElementById('wstep-2');
    var wstep3El         = document.getElementById('wstep-3');
    var wstep4El         = document.getElementById('wstep-4');
    var wDots            = [
      document.getElementById('wdot-1'),
      document.getElementById('wdot-2'),
      document.getElementById('wdot-3'),
      document.getElementById('wdot-4'),
    ];
    var wizardStepLabel  = document.getElementById('wizard-step-label');
    var wNameInput       = document.getElementById('w-name');
    var wTitleInput      = document.getElementById('w-title');
    var wSignatureInput  = document.getElementById('w-signature');
    var wVerbosityInput  = document.getElementById('w-verbosity');
    var wDirectnessInput = document.getElementById('w-directness');
    var wPrefsInput      = document.getElementById('w-preferences');
    var wstep1Error      = document.getElementById('wstep1-error');
    var wizardError      = document.getElementById('wizard-error');
    var wizardSaveBtn    = document.getElementById('wizard-save-btn');
    var chatSuccessBanner = document.getElementById('chat-success-banner');

    // Catch template/script divergence early rather than producing cryptic null errors
    if (!authWall || !mainApp || !authForm || !authInput || !authError ||
        !statusEl || !resultsEl || !searchInput || !searchBtn ||
        !memoryCaret || !memorySubmenu || !settingsSubmenu || !settingsCaret ||
        !contactsStatusEl || !contactsSearchInput || !contactsSearchBtn ||
        !contactsNewBtn || !contactsListEl || !contactsForm || !contactsEditorTitle ||
        !contactsDeleteBtn || !contactsSaveBtn || !contactsCancelBtn ||
        !contactDisplayNameInput || !contactRoleInput || !contactStatusInput ||
        !contactKgNodeIdInput || !contactNotesInput ||
        !tasksStatusEl || !tasksSearchInput || !tasksSearchBtn || !tasksNewBtn ||
        !tasksListEl || !tasksForm || !tasksEditorTitle || !tasksDeleteBtn ||
        !tasksSaveBtn || !tasksCancelBtn || !taskAgentIdInput || !taskStatusInput ||
        !taskIntentAnchorInput || !taskConversationIdInput || !taskScheduledJobIdInput ||
        !taskErrorBudgetInput || !taskProgressInput ||
        !jobsStatusEl || !jobsSearchInput || !jobsSearchBtn || !jobsNewBtn || !jobsListEl ||
        !jobsForm || !jobsEditorTitle || !jobsDeleteBtn || !jobsSaveBtn || !jobsCancelBtn ||
        !jobAgentIdInput || !jobStatusInput || !jobCronExprInput || !jobRunAtInput ||
        !jobIntentAnchorInput || !jobTaskPayloadInput ||
        !wstep1El || !wstep2El || !wstep3El || !wstep4El ||
        wDots.some(function(d) { return !d; }) ||
        !wizardStepLabel || !wNameInput || !wTitleInput || !wSignatureInput ||
        !wVerbosityInput || !wDirectnessInput || !wPrefsInput ||
        !wstep1Error || !wizardError || !wizardSaveBtn || !chatSuccessBanner ||
        !chatMessagesEl || !chatConvListEl || !chatForm || !chatTextarea || !chatSendBtn) {
      throw new Error('Curia KG: required DOM element missing — check template integrity.');
    }

    // ── Auth ───────────────────────────────────────────────────────────
    // Session is maintained by an HttpOnly cookie set by POST /auth.
    // The secret never lives in JS-land after the exchange.

    function showMain() {
      authWall.style.display = 'none';
      // Check whether identity has been configured via the wizard. If not, show the
      // wizard overlay. Main app stays hidden until wizard completes (or identity check fails).
      fetch('/api/identity')
        .then(function(res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then(function(data) {
          if (!data.configured) {
            // Reveal the main app shell before showing the wizard — #view-wizard is
            // position:fixed but it's still a DOM child of #main-app, so display:none
            // on the parent hides it regardless of positioning.
            mainApp.style.display = 'flex';
            initCytoscape();
            showWizard(data.identity);
          } else {
            mainApp.style.display = 'flex';
            navigate('chat', 'Chat', 'nav-chat');
            initCytoscape();
          }
        })
        .catch(function(err) {
          // Identity service not available or check failed — fall back to main app.
          // Log so operators can diagnose DB/network issues at login time.
          console.error('[curia] identity check failed on login:', err);
          mainApp.style.display = 'flex';
          navigate('chat', 'Chat', 'nav-chat');
          initCytoscape();
        });
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
      // Register the fcose layout extension once, before creating the instance.
      // cytoscapeFcose is the browser global set by /assets/cytoscape-fcose.js.
      cytoscape.use(cytoscapeFcose);
      cy = cytoscape({
        container: document.getElementById('cy'),
        elements: [],
        style: [
          // ── Base node style ──────────────────────────────────────────
          {
            selector: 'node',
            style: {
              label: 'data(label)',
              'background-color': '#4174C8',
              color: '#FAFAFA',
              // Labels sit below the node circle so they don't compete with
              // the node's size/colour encoding — biggest readability win.
              'text-valign': 'bottom',
              'text-halign': 'center',
              'text-margin-y': 5,
              'text-outline-color': '#111827',
              'text-outline-width': 2,
              'text-wrap': 'ellipsis',
              'text-max-width': '90px',
              'font-size': 10,
              'font-family': 'Manrope, system-ui, sans-serif',
              // Base size is overridden per-type below; confidence scales
              // add on top of the type base via mapData.
              width: 32,
              height: 32,
            },
          },
          // ── Type colours ─────────────────────────────────────────────
          { selector: 'node[type="person"]',       style: { 'background-color': '#478189' } }, // teal
          { selector: 'node[type="organization"]',  style: { 'background-color': '#6BAED6' } }, // light blue
          { selector: 'node[type="project"]',       style: { 'background-color': '#7E6BA8' } }, // purple
          { selector: 'node[type="decision"]',      style: { 'background-color': '#C9874A' } }, // amber
          { selector: 'node[type="event"]',         style: { 'background-color': '#5E9E6B' } }, // green
          { selector: 'node[type="concept"]',       style: { 'background-color': '#888888' } }, // mid-grey
          { selector: 'node[type="fact"]',          style: { 'background-color': '#444444' } }, // dark grey
          // ── Type-based base sizes (issue 5) ─────────────────────────
          // Entities that anchor the graph get more canvas real-estate so
          // their labels are readable and they visually dominate leaf nodes.
          { selector: 'node[type="person"]',       style: { width: 44, height: 44 } },
          { selector: 'node[type="organization"]',  style: { width: 44, height: 44 } },
          { selector: 'node[type="project"]',       style: { width: 36, height: 36 } },
          { selector: 'node[type="decision"]',      style: { width: 32, height: 32 } },
          { selector: 'node[type="event"]',         style: { width: 28, height: 28 } },
          { selector: 'node[type="concept"]',       style: { width: 24, height: 24 } },
          // Facts are tiny — they're leaf annotations, not key entities.
          { selector: 'node[type="fact"]',          style: { width: 14, height: 14, 'font-size': 0 } },
          // Show fact labels when selected (they're too small to show by default).
          { selector: 'node[type="fact"]:selected', style: { 'font-size': 9 } },
          // ── Confidence-based opacity (issue 2) ──────────────────────
          // Stale / low-confidence nodes fade out so the high-signal nodes pop.
          { selector: 'node[decayClass="fast_decay"]', style: { opacity: 0.45 } },
          { selector: 'node[decayClass="slow_decay"]', style: { opacity: 0.75 } },
          // permanent nodes keep full opacity (no rule needed — default is 1).
          // ── Focal node highlight (issue 4) ───────────────────────────
          {
            selector: 'node.focal',
            style: {
              'border-width': 3,
              'border-color': '#FAFAFA',
              'border-opacity': 0.9,
            },
          },
          // ── Edge style ───────────────────────────────────────────────
          {
            selector: 'edge',
            style: {
              // Width and opacity both reflect confidence so weak relationships
              // visually recede behind strong ones.
              width: 'mapData(confidence, 0, 1, 1, 3.5)',
              opacity: 'mapData(confidence, 0, 1, 0.15, 0.7)',
              'line-color': 'rgba(255,255,255,0.6)',
              'curve-style': 'bezier',
              'target-arrow-shape': 'triangle',
              'target-arrow-color': 'rgba(255,255,255,0.6)',
              label: 'data(label)',
              'font-size': 8,
              'font-family': 'Manrope, system-ui, sans-serif',
              color: '#ADADAD',
              'text-outline-color': '#111827',
              'text-outline-width': 1,
            },
          },
        ],
        // Initial layout runs via renderGraph(); this is a fallback only.
        layout: { name: 'fcose', animate: false },
      });

      // ── Graph interaction handlers ───────────────────────────────────
      // Single-tap a node: expand its neighborhood in-place (issue 4).
      cy.on('tap', 'node', function(evt) {
        expandNeighborhood(evt.target.id());
      });

      // Double-tap a node: zoom/pan to fit its immediate neighborhood (issue 4).
      cy.on('dbltap', 'node', function(evt) {
        cy.animate(
          { fit: { eles: evt.target.closedNeighborhood(), padding: 60 } },
          { duration: 300 }
        );
      });
    }

    // ── Navigation ─────────────────────────────────────────────────────
    function navigate(view, title, navId) {
      var kgView            = document.getElementById('view-kg');
      var chatView          = document.getElementById('view-chat');
      var contactsView      = document.getElementById('view-contacts');
      var tasksView         = document.getElementById('view-tasks');
      var scheduledJobsView = document.getElementById('view-scheduled-jobs');
      var viewWizard        = document.getElementById('view-wizard');

      // When navigating to the wizard, fetch the current identity to pre-fill fields,
      // then delegate to showWizard(). Return early — the wizard has its own overlay.
      if (view === 'wizard') {
        // Update active highlight before delegating — same ordering as all other nav paths.
        if (activeNavId) {
          var prev = document.getElementById(activeNavId);
          if (prev) prev.classList.remove('active');
        }
        if (navId) {
          var curr = document.getElementById(navId);
          if (curr) curr.classList.add('active');
          activeNavId = navId;
        }
        fetch('/api/identity')
          .then(function(res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
          })
          .then(function(data) { showWizard(data.identity); })
          .catch(function(err) {
            console.error('[curia] failed to load identity for wizard pre-fill:', err);
            showWizard(null);
          });
        return;
      }

      kgView.style.display            = view === 'kg'             ? 'flex' : 'none';
      chatView.style.display          = view === 'chat'           ? 'flex' : 'none';
      contactsView.style.display      = view === 'contacts'       ? 'flex' : 'none';
      tasksView.style.display         = view === 'tasks'          ? 'flex' : 'none';
      scheduledJobsView.style.display = view === 'scheduled-jobs' ? 'flex' : 'none';
      if (viewWizard) viewWizard.style.display = 'none'; // always hide when navigating elsewhere
      // When returning to the KG view, tell Cytoscape to re-measure the container.
      // The canvas dimensions may be stale if the view was hidden (display:none)
      // since the last render. Defer to requestAnimationFrame so the browser
      // completes layout on the newly-visible container before we read its
      // dimensions — calling cy.resize() synchronously after a display change
      // can still see stale 0x0 values in some browser/flex combinations.
      if (view === 'kg' && cy) {
        requestAnimationFrame(function() {
          cy.resize();
          cy.fit();
        });
      }
      if (view === 'kg') {
        search(); // populate the sidebar node list
        // Auto-load a hero graph on first entry so the canvas is never blank.
        // Only fires when the canvas is empty (fresh load or full reset).
        if (cy && cy.elements().length === 0) {
          loadDefaultGraph();
        }
      }
      if (view === 'contacts') {
        loadContacts();
      }
      if (view === 'tasks') {
        loadTasks();
      }
      if (view === 'scheduled-jobs') {
        loadJobs();
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

    function toggleSettings() {
      settingsOpen = !settingsOpen;
      settingsSubmenu.style.display = settingsOpen ? 'flex' : 'none';
      settingsCaret.classList.toggle('collapsed', !settingsOpen);
    }

    // ── Wizard step management ─────────────────────────────────────────

    function navigateWizardStep(n) {
      wstep1El.style.display = n === 1 ? 'flex' : 'none';
      wstep2El.style.display = n === 2 ? 'flex' : 'none';
      wstep3El.style.display = n === 3 ? 'flex' : 'none';
      wstep4El.style.display = n === 4 ? 'flex' : 'none';
      // Dots for steps before n are filled; current and future are empty.
      wDots.forEach(function(dot, i) { dot.classList.toggle('done', i < n); });
      wizardStepLabel.textContent = 'Step ' + n + ' of 4';
      wizardState.step = n;
      if (n === 2) {
        buildTonePills();
        syncPostureSelection();
        updateVerbosityPreview();
        updateDirectnessPreview();
      }
      if (n === 4) { renderReview(); }
    }

    function showWizard(identity) {
      // Treat null/undefined identity as an empty object — all fields fall back to defaults.
      if (!identity) identity = {};
      wizardState.name      = (identity && identity.assistant && identity.assistant.name)      || '';
      wizardState.title     = (identity && identity.assistant && identity.assistant.title)     || '';
      wizardState.signature = (identity && identity.assistant && identity.assistant.emailSignature) || '';
      wizardState.toneBaseline = (identity && identity.tone && identity.tone.baseline && identity.tone.baseline.length)
        ? identity.tone.baseline.slice() : ['warm', 'direct'];
      wizardState.verbosity  = (identity && identity.tone && identity.tone.verbosity  != null) ? identity.tone.verbosity  : 50;
      wizardState.directness = (identity && identity.tone && identity.tone.directness != null) ? identity.tone.directness : 75;
      wizardState.posture    = (identity && identity.decisionStyle && identity.decisionStyle.externalActions)
        ? identity.decisionStyle.externalActions : 'conservative';
      wizardState.preferences = '';

      wNameInput.value       = wizardState.name;
      wTitleInput.value      = wizardState.title;
      wSignatureInput.value  = wizardState.signature;
      wVerbosityInput.value  = String(wizardState.verbosity);
      wDirectnessInput.value = String(wizardState.directness);
      wPrefsInput.value      = '';

      // Reset pill grid so it rebuilds with the new selection state.
      var grid = document.getElementById('tone-pill-grid');
      if (grid) grid.replaceChildren();

      document.getElementById('view-wizard').style.display = 'flex';
      wstep1Error.style.display = 'none';
      wizardError.style.display = 'none';
      navigateWizardStep(1);
    }

    function hideWizard() {
      document.getElementById('view-wizard').style.display = 'none';
    }

    function validateWizardStep(n) {
      if (n === 1) {
        var name = wNameInput.value.trim();
        if (!name) {
          wstep1Error.textContent = 'Assistant name is required.';
          wstep1Error.style.display = 'block';
          return false;
        }
        wstep1Error.style.display = 'none';
        wizardState.name      = name;
        wizardState.title     = wTitleInput.value.trim();
        wizardState.signature = wSignatureInput.value.trim();
        return true;
      }
      if (n === 2) {
        if (wizardState.toneBaseline.length === 0) return false;
        wizardState.verbosity  = Number(wVerbosityInput.value);
        wizardState.directness = Number(wDirectnessInput.value);
        return true;
      }
      if (n === 3) {
        wizardState.preferences = wPrefsInput.value.trim();
        return true;
      }
      return true;
    }

    function wizardNext() {
      if (!validateWizardStep(wizardState.step)) return;
      if (wizardState.step < 4) navigateWizardStep(wizardState.step + 1);
    }

    function wizardBack() {
      if (wizardState.step > 1) navigateWizardStep(wizardState.step - 1);
    }

    // ── Tone pills ─────────────────────────────────────────────────────

    function buildTonePills() {
      var grid = document.getElementById('tone-pill-grid');
      // Rebuild on each entry so the selection syncs with current wizardState.
      if (grid.children.length > 0) {
        syncPillSelections();
        updateTonePreview();
        return;
      }
      TONE_OPTIONS.forEach(function(word) {
        var btn = document.createElement('button');
        btn.className = 'tone-pill';
        btn.textContent = word;
        btn.dataset.word = word;
        btn.addEventListener('click', function() { toggleTonePill(btn, word); });
        grid.appendChild(btn);
      });
      syncPillSelections();
      updateTonePreview();
    }

    function syncPillSelections() {
      var grid = document.getElementById('tone-pill-grid');
      var atMax = wizardState.toneBaseline.length >= 3;
      Array.from(grid.children).forEach(function(btn) {
        var word = btn.dataset.word;
        var isSelected = wizardState.toneBaseline.indexOf(word) !== -1;
        btn.classList.toggle('selected', isSelected);
        btn.classList.toggle('disabled', atMax && !isSelected);
        btn.disabled = atMax && !isSelected;
      });
    }

    function toggleTonePill(btn, word) {
      var idx = wizardState.toneBaseline.indexOf(word);
      if (idx !== -1) {
        // Minimum 1: prevent deselecting the last word.
        if (wizardState.toneBaseline.length <= 1) return;
        wizardState.toneBaseline.splice(idx, 1);
      } else {
        if (wizardState.toneBaseline.length >= 3) return;
        wizardState.toneBaseline.push(word);
      }
      syncPillSelections();
      updateTonePreview();
    }

    function updateTonePreview() {
      var words = wizardState.toneBaseline;
      var phrase = words.length === 1 ? words[0]
        : words.length === 2 ? words[0] + ' and ' + words[1]
        : words[0] + ', ' + words[1] + ' and ' + words[2];
      var suffix = words.length >= 3 ? ' (Pick up to 3)' : '';
      document.getElementById('tone-preview').textContent =
        words.length > 0 ? 'Your tone is ' + phrase + '.' + suffix : '';
    }

    // ── Slider previews ────────────────────────────────────────────────

    function verbosityBand(v) {
      if (v <= 25) return '\u201cHere\u2019s the short answer.\u201d';
      if (v <= 50) return '\u201cHappy to help \u2014 let me know if you\u2019d like more detail.\u201d';
      if (v <= 75) return '\u201cHere\u2019s what you need to know, plus a bit of context.\u201d';
      return '\u201cLet me walk you through this thoroughly.\u201d';
    }

    function directnessBand(v) {
      if (v <= 25) return '\u201cThere are a few things worth considering here \u2014 it\u2019s hard to say definitively.\u201d';
      if (v <= 50) return '\u201cI\u2019d lean toward option A, though it depends on your priorities.\u201d';
      if (v <= 75) return '\u201cThursday works. I\u2019ll send the invite.\u201d';
      return '\u201cDo it. The risk is low and the upside is clear.\u201d';
    }

    function updateVerbosityPreview() {
      document.getElementById('verbosity-preview').textContent = verbosityBand(Number(wVerbosityInput.value));
    }

    function updateDirectnessPreview() {
      document.getElementById('directness-preview').textContent = directnessBand(Number(wDirectnessInput.value));
    }

    // ── Posture picker ─────────────────────────────────────────────────

    function selectPosture(value) {
      wizardState.posture = value;
      document.querySelectorAll('.posture-card').forEach(function(card) {
        card.classList.toggle('selected', card.dataset.posture === value);
      });
    }

    function syncPostureSelection() {
      selectPosture(wizardState.posture);
    }

    // ── Review & submit ────────────────────────────────────────────────

    function renderReview() {
      var card = document.getElementById('review-card');
      // Remove all existing child nodes safely (no innerHTML — user input could contain HTML).
      while (card.firstChild) card.removeChild(card.firstChild);

      var v = wizardState.verbosity;
      var verbosityDesc = v <= 25 ? 'Very brief responses — just the essentials.'
        : v <= 50 ? 'Concise responses by default.'
        : v <= 75 ? 'Adapts length to the situation.'
        : 'Thorough by default — full context included.';

      var d = wizardState.directness;
      var directnessDesc = d <= 25 ? 'Measured — acknowledges uncertainty carefully.'
        : d <= 50 ? 'Leans direct but hedges where uncertain.'
        : d <= 75 ? 'Direct — minimal unnecessary hedging.'
        : 'States positions plainly; no softening.';

      var postureMap = {
        conservative: 'Verifies before acting on external requests.',
        balanced:     'Acts when confident; flags when uncertain.',
        proactive:    'Biases toward action with less checking in.',
      };
      var postureDesc = postureMap[wizardState.posture] || '';

      var words = wizardState.toneBaseline;
      var tonePhrase = words.length === 1 ? words[0]
        : words.length === 2 ? words[0] + ' and ' + words[1]
        : words[0] + ', ' + words[1] + ' and ' + words[2];

      var rows = [
        { label: 'Assistant', value: wizardState.name + (wizardState.title ? ' \u2014 ' + wizardState.title : '') },
        { label: 'Tone',      value: 'Your tone is ' + tonePhrase + '.' },
        { label: 'Detail',    value: verbosityDesc },
        { label: 'Directness', value: directnessDesc },
        { label: 'Posture',   value: postureDesc },
      ];
      if (wizardState.preferences) {
        rows.push({ label: 'Preference', value: '\u201c' + wizardState.preferences + '\u201d' });
      }

      rows.forEach(function(row) {
        var rowEl   = document.createElement('div');
        rowEl.className = 'review-row';
        var labelEl = document.createElement('div');
        labelEl.className = 'review-row-label';
        labelEl.textContent = row.label;
        var valueEl = document.createElement('div');
        valueEl.className = 'review-row-value';
        valueEl.textContent = row.value; // textContent — safe even with user input
        rowEl.appendChild(labelEl);
        rowEl.appendChild(valueEl);
        card.appendChild(rowEl);
      });
    }

    function submitWizard() {
      wizardSaveBtn.disabled = true;
      wizardSaveBtn.textContent = 'Saving\u2026';
      wizardError.style.display = 'none';

      // Fetch current identity to preserve behavioral_preferences and constraints.
      fetch('/api/identity')
        .then(function(res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then(function(data) {
          var current = (data && data.identity) ? data.identity : {};
          var prefs = Array.isArray(current.behavioralPreferences) ? current.behavioralPreferences.slice() : [];
          if (wizardState.preferences) { prefs.push(wizardState.preferences); }

          var payload = {
            identity: {
              assistant: {
                name: wizardState.name,
                title: wizardState.title,
                emailSignature: wizardState.signature,
              },
              tone: {
                baseline: wizardState.toneBaseline,
                verbosity: wizardState.verbosity,
                directness: wizardState.directness,
              },
              behavioralPreferences: prefs,
              decisionStyle: {
                externalActions: wizardState.posture,
                // internal_analysis is not surfaced in the wizard — preserve existing value.
                internalAnalysis: (current.decisionStyle && current.decisionStyle.internalAnalysis)
                  ? current.decisionStyle.internalAnalysis : 'proactive',
              },
              // constraints are immutable via wizard — always preserve.
              constraints: current.constraints || [],
            },
            changedBy: 'wizard',
            note: 'Saved via onboarding wizard',
          };

          return fetch('/api/identity', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
        })
        .then(function(res) {
          if (!res.ok) {
            return res.text().then(function(text) {
              var msg = 'Save failed';
              try { msg = JSON.parse(text).error || msg; } catch (_) {}
              throw new Error(msg);
            });
          }
          return fetch('/api/identity/reload', { method: 'POST' });
        })
        .then(function(res) {
          if (!res.ok) {
            // Identity was saved to DB, but the in-memory cache was not refreshed.
            // The error path re-enables the button so the user can retry.
            throw new Error('Identity saved but in-memory reload failed \u2014 please try again or restart the server.');
          }
          hideWizard();
          navigate('chat', 'Chat', 'nav-chat');
          chatSuccessBanner.style.display = 'block';
          setTimeout(function() { chatSuccessBanner.style.display = 'none'; }, 4000);
        })
        .catch(function(err) {
          wizardError.textContent = err.message || 'Something went wrong — please try again.';
          wizardError.style.display = 'block';
          wizardSaveBtn.disabled = false;
          wizardSaveBtn.textContent = 'Confirm \u0026 save';
        });
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

    // Maps a node row from the API into a Cytoscape element descriptor.
    // All metadata (confidence, decayClass) is forwarded so styles can encode
    // it visually via mapData() and class selectors.
    function nodeToElement(n) {
      return {
        data: {
          id: n.id,
          label: n.label,
          type: n.type,
          confidence: n.confidence != null ? n.confidence : 0.5,
          decayClass: n.decayClass || 'permanent',
        },
      };
    }

    // Maps an edge row from the API into a Cytoscape element descriptor.
    function edgeToElement(e) {
      return {
        data: {
          id: e.id,
          source: e.sourceNodeId,
          target: e.targetNodeId,
          label: e.type,
          confidence: e.confidence != null ? e.confidence : 0.5,
        },
      };
    }

    // Shared fcose layout options — used by both full redraws and in-place expansions.
    var FCOSE_OPTS_FULL    = { name: 'fcose', animate: false, fit: true,  nodeSeparation: 80, idealEdgeLength: 120, randomize: true };
    var FCOSE_OPTS_EXPAND  = { name: 'fcose', animate: true,  fit: false, nodeSeparation: 80, idealEdgeLength: 120, randomize: false, animationDuration: 400 };

    // Full graph replacement — called when loading a neighbourhood from the sidebar
    // or when resetting to the hero view. Wipes the canvas and re-runs layout.
    function renderGraph(payload) {
      if (!cy) return;
      var elements = payload.nodes.map(nodeToElement).concat(payload.edges.map(edgeToElement));
      cy.elements().remove();
      cy.add(elements);
      // Force Cytoscape to re-measure the container before running layout.
      // Without this, the canvas may still be sized 0×0 from when main-app was
      // display:none (e.g. on first load or after navigating away and back).
      cy.resize();
      cy.layout(FCOSE_OPTS_FULL).run();
    }

    // In-place expansion — adds only new nodes/edges so the existing graph context
    // is preserved. Highlights the tapped node as the focal point.
    function expandNeighborhood(nodeId) {
      if (!cy) return;
      setStatus('Expanding\u2026');
      fetchJson('/api/kg/graph?node_id=' + encodeURIComponent(nodeId) + '&depth=1')
        .then(function(data) {
          var newNodes = data.nodes.filter(function(n) { return !cy.getElementById(n.id).length; });
          var newEdges = data.edges.filter(function(e) { return !cy.getElementById(e.id).length; });
          var newElements = newNodes.map(nodeToElement).concat(newEdges.map(edgeToElement));

          if (newElements.length > 0) {
            // Snapshot existing node positions BEFORE adding new elements so we
            // can pass them as fixedNodeConstraint to fcose. This pins every
            // pre-existing node in place — only the newly added nodes are
            // positioned by the layout engine, so nothing jumps around.
            var fixedConstraints = [];
            cy.nodes().forEach(function(node) {
              var p = node.position();
              fixedConstraints.push({ nodeId: node.id(), position: { x: p.x, y: p.y } });
            });

            cy.add(newElements);

            var expandOpts = Object.assign({}, FCOSE_OPTS_EXPAND, {
              fixedNodeConstraint: fixedConstraints,
            });
            cy.layout(expandOpts).run();
          }

          // Mark the tapped node as focal so it gets a white border highlight.
          cy.elements().removeClass('focal');
          cy.getElementById(nodeId).addClass('focal');

          var totalNodes = cy.nodes().length;
          var totalEdges = cy.edges().length;
          setStatus(totalNodes + ' nodes \u00B7 ' + totalEdges + ' edges');
        })
        .catch(function(err) { setStatus(String(err), true); });
    }

    // Hero view — loaded automatically on first KG entry when the canvas is empty.
    // Fetches the most recently active nodes (no node_id = top-N by last_confirmed_at).
    function loadDefaultGraph() {
      setStatus('Loading\u2026');
      fetchJson('/api/kg/graph?limit=20')
        .then(function(data) {
          renderGraph(data);
          setStatus(data.nodes.length + ' nodes \u00B7 ' + data.edges.length + ' edges');
        })
        .catch(function(err) { setStatus(String(err), true); });
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

    // Called from the sidebar node list — replaces the whole canvas with the
    // selected node's depth-2 neighbourhood.
    function loadNeighborhood(nodeId) {
      setStatus('Loading\u2026');
      fetchJson('/api/kg/graph?node_id=' + encodeURIComponent(nodeId) + '&depth=2')
        .then(function(data) {
          renderGraph(data);
          // Mark the selected node as focal after render.
          cy.getElementById(nodeId).addClass('focal');
          setStatus(data.nodes.length + ' nodes \u00B7 ' + data.edges.length + ' edges');
        })
        .catch(function(err) { setStatus(String(err), true); });
    }

    searchBtn.addEventListener('click', search);
    searchInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') search(); });

    // ── Contacts ──────────────────────────────────────────────────────
    function setContactsStatus(msg, isError) {
      contactsStatusEl.textContent = msg;
      contactsStatusEl.style.color = isError ? 'var(--destructive)' : 'var(--fg-muted)';
    }

    function resetContactForm() {
      contactsMode = 'create';
      selectedContactId = null;
      contactsEditorTitle.textContent = 'Create Contact';
      contactsSaveBtn.textContent = 'Create Contact';
      contactsDeleteBtn.style.display = 'none';
      contactDisplayNameInput.value = '';
      contactRoleInput.value = '';
      contactStatusInput.value = 'confirmed';
      contactKgNodeIdInput.value = '';
      contactNotesInput.value = '';
      renderContactsList(contacts);
    }

    function fillContactForm(contact) {
      contactsMode = 'edit';
      selectedContactId = contact.id;
      contactsEditorTitle.textContent = 'Edit Contact';
      contactsSaveBtn.textContent = 'Save Changes';
      contactsDeleteBtn.style.display = 'inline-flex';
      contactDisplayNameInput.value = contact.displayName;
      contactRoleInput.value = contact.role || '';
      contactStatusInput.value = contact.status;
      contactKgNodeIdInput.value = contact.kgNodeId || '';
      contactNotesInput.value = contact.notes || '';
      renderContactsList(contacts);
    }

    function renderContactsList(list) {
      contactsListEl.replaceChildren();
      if (!list.length) {
        var empty = document.createElement('p');
        empty.style.cssText = 'font-size: 0.8125rem; color: var(--fg-muted); margin: 4px 2px;';
        empty.textContent = 'No contacts found.';
        contactsListEl.appendChild(empty);
        return;
      }
      list.forEach(function(contact) {
        var card = document.createElement('div');
        card.className = 'contact-card' + (selectedContactId === contact.id ? ' active' : '');
        var name = document.createElement('div');
        name.style.cssText = 'font-size: 0.875rem; font-weight: 600; color: var(--fg);';
        name.textContent = contact.displayName;
        var meta = document.createElement('div');
        meta.style.cssText = 'font-size: 0.75rem; color: var(--fg-muted); margin-top: 3px;';
        meta.textContent = (contact.role || 'No role') + ' · ' + contact.status;
        card.append(name, meta);
        card.addEventListener('click', function() { fillContactForm(contact); });
        contactsListEl.appendChild(card);
      });
    }

    function loadContacts() {
      setContactsStatus('Loading contacts…');
      fetchJson('/api/kg/contacts')
        .then(function(data) {
          contacts = data.contacts || [];
          renderContactsList(contacts);
          setContactsStatus(contacts.length + ' contact' + (contacts.length === 1 ? '' : 's'));
          if (contactsMode === 'edit') {
            var selected = contacts.find(function(c) { return c.id === selectedContactId; });
            if (selected) {
              fillContactForm(selected);
            } else {
              resetContactForm();
            }
          }
        })
        .catch(function(err) { setContactsStatus(String(err), true); });
    }

    function filterContacts() {
      var q = contactsSearchInput.value.trim().toLowerCase();
      if (!q) {
        renderContactsList(contacts);
        setContactsStatus(contacts.length + ' contact' + (contacts.length === 1 ? '' : 's'));
        return;
      }
      var filtered = contacts.filter(function(c) {
        return c.displayName.toLowerCase().includes(q) || (c.role || '').toLowerCase().includes(q);
      });
      renderContactsList(filtered);
      setContactsStatus(filtered.length + ' result' + (filtered.length === 1 ? '' : 's'));
    }

    function saveContact(e) {
      e.preventDefault();
      var displayName = contactDisplayNameInput.value.trim();
      if (!displayName) {
        setContactsStatus('Display name is required.', true);
        return;
      }

      var payload = {
        displayName: displayName,
        role: contactRoleInput.value.trim() || null,
        status: contactStatusInput.value,
        kgNodeId: contactKgNodeIdInput.value.trim() || null,
        notes: contactNotesInput.value.trim() || null,
      };

      contactsSaveBtn.disabled = true;
      setContactsStatus(contactsMode === 'create' ? 'Creating contact…' : 'Saving contact…');

      var request = contactsMode === 'create'
        ? fetch('/api/kg/contacts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          })
        : fetch('/api/kg/contacts/' + encodeURIComponent(selectedContactId), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });

      request
        .then(function(res) {
          return res.json().then(function(body) {
            if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
            return body;
          });
        })
        .then(function() {
          setContactsStatus(contactsMode === 'create' ? 'Contact created.' : 'Contact updated.');
          loadContacts();
          if (contactsMode === 'create') resetContactForm();
        })
        .catch(function(err) { setContactsStatus(err.message || String(err), true); })
        .finally(function() { contactsSaveBtn.disabled = false; });
    }

    function deleteContact() {
      if (!selectedContactId) return;
      if (!confirm('Delete this contact? This action cannot be undone.')) return;
      contactsDeleteBtn.disabled = true;
      setContactsStatus('Deleting contact…');
      fetch('/api/kg/contacts/' + encodeURIComponent(selectedContactId), { method: 'DELETE' })
        .then(function(res) {
          if (!res.ok) return res.json().then(function(body) { throw new Error(body.error || ('HTTP ' + res.status)); });
        })
        .then(function() {
          setContactsStatus('Contact deleted.');
          resetContactForm();
          loadContacts();
        })
        .catch(function(err) { setContactsStatus(err.message || String(err), true); })
        .finally(function() { contactsDeleteBtn.disabled = false; });
    }

    contactsForm.addEventListener('submit', saveContact);
    contactsDeleteBtn.addEventListener('click', deleteContact);
    contactsNewBtn.addEventListener('click', resetContactForm);
    contactsCancelBtn.addEventListener('click', resetContactForm);
    contactsSearchBtn.addEventListener('click', filterContacts);
    contactsSearchInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        filterContacts();
      }
    });

    // ── Agent Tasks ──────────────────────────────────────────────────
    function setTasksStatus(msg, isError) {
      tasksStatusEl.textContent = msg;
      tasksStatusEl.style.color = isError ? 'var(--destructive)' : 'var(--fg-muted)';
    }

    function prettyJson(value) {
      return JSON.stringify(value || {}, null, 2);
    }

    function parseJsonField(raw, fallback, fieldName) {
      var value = raw.trim();
      if (!value) return fallback;
      try {
        return JSON.parse(value);
      } catch {
        throw new Error(fieldName + ' must be valid JSON.');
      }
    }

    function resetTaskForm() {
      tasksMode = 'create';
      selectedTaskId = null;
      tasksEditorTitle.textContent = 'Create Agent Task';
      tasksSaveBtn.textContent = 'Create Agent Task';
      tasksDeleteBtn.style.display = 'none';
      taskAgentIdInput.value = '';
      taskStatusInput.value = 'active';
      taskIntentAnchorInput.value = '';
      taskConversationIdInput.value = '';
      taskScheduledJobIdInput.value = '';
      taskErrorBudgetInput.value = prettyJson({ maxTurns: 12, maxConsecutiveErrors: 3 });
      taskProgressInput.value = prettyJson({});
      renderTasksList(tasks);
    }

    function fillTaskForm(task) {
      tasksMode = 'edit';
      selectedTaskId = task.id;
      tasksEditorTitle.textContent = 'Edit Agent Task';
      tasksSaveBtn.textContent = 'Save Changes';
      tasksDeleteBtn.style.display = 'inline-flex';
      taskAgentIdInput.value = task.agentId;
      taskStatusInput.value = task.status;
      taskIntentAnchorInput.value = task.intentAnchor;
      taskConversationIdInput.value = task.conversationId || '';
      taskScheduledJobIdInput.value = task.scheduledJobId || '';
      taskErrorBudgetInput.value = prettyJson(task.errorBudget);
      taskProgressInput.value = prettyJson(task.progress);
      renderTasksList(tasks);
    }

    function renderTasksList(list) {
      tasksListEl.replaceChildren();
      if (!list.length) {
        var empty = document.createElement('p');
        empty.style.cssText = 'font-size: 0.8125rem; color: var(--fg-muted); margin: 4px 2px;';
        empty.textContent = 'No agent tasks found.';
        tasksListEl.appendChild(empty);
        return;
      }
      list.forEach(function(task) {
        var card = document.createElement('div');
        card.className = 'task-card' + (selectedTaskId === task.id ? ' active' : '');

        var title = document.createElement('div');
        title.style.cssText = 'font-size: 0.875rem; font-weight: 600; color: var(--fg);';
        title.textContent = task.agentId + ' · ' + task.status;

        var intent = document.createElement('div');
        intent.style.cssText = 'font-size: 0.75rem; color: var(--fg-muted); margin-top: 4px; line-height: 1.35;';
        intent.textContent = task.intentAnchor;

        var meta = document.createElement('div');
        meta.style.cssText = 'font-size: 0.6875rem; color: var(--fg-muted); margin-top: 6px;';
        meta.textContent = 'Updated ' + new Date(task.updatedAt).toLocaleString();

        card.append(title, intent, meta);
        card.addEventListener('click', function() { fillTaskForm(task); });
        tasksListEl.appendChild(card);
      });
    }

    function loadTasks() {
      setTasksStatus('Loading agent tasks…');
      fetchJson('/api/kg/tasks')
        .then(function(data) {
          tasks = data.tasks || [];
          // Re-apply active search filter after reload instead of always showing the full list.
          // Without this, saving/deleting a task would silently clear the user's filter while
          // leaving the search input populated — a misleading UI state.
          if (tasksSearchInput.value.trim()) {
            filterTasks();
          } else {
            renderTasksList(tasks);
            setTasksStatus(tasks.length + ' agent task' + (tasks.length === 1 ? '' : 's'));
          }
          if (tasksMode === 'create' && !taskAgentIdInput.value) {
            resetTaskForm();
            return;
          }
          if (tasksMode === 'edit') {
            var selected = tasks.find(function(t) { return t.id === selectedTaskId; });
            if (selected) {
              fillTaskForm(selected);
            } else {
              resetTaskForm();
            }
          }
        })
        .catch(function(err) { setTasksStatus(String(err), true); });
    }

    function filterTasks() {
      var q = tasksSearchInput.value.trim().toLowerCase();
      if (!q) {
        renderTasksList(tasks);
        setTasksStatus(tasks.length + ' agent task' + (tasks.length === 1 ? '' : 's'));
        return;
      }
      var filtered = tasks.filter(function(task) {
        return task.agentId.toLowerCase().includes(q) ||
          task.intentAnchor.toLowerCase().includes(q) ||
          task.status.toLowerCase().includes(q);
      });
      renderTasksList(filtered);
      setTasksStatus(filtered.length + ' result' + (filtered.length === 1 ? '' : 's'));
    }

    function saveTask(e) {
      e.preventDefault();
      var agentId = taskAgentIdInput.value.trim();
      var intentAnchor = taskIntentAnchorInput.value.trim();
      if (!agentId) {
        setTasksStatus('Agent ID is required.', true);
        return;
      }
      if (!intentAnchor) {
        setTasksStatus('Intent anchor is required.', true);
        return;
      }

      var errorBudget;
      var progress;
      try {
        errorBudget = parseJsonField(taskErrorBudgetInput.value, {}, 'Error budget');
        progress = parseJsonField(taskProgressInput.value, {}, 'Progress');
      } catch (err) {
        setTasksStatus(err.message || String(err), true);
        return;
      }

      var payload = {
        agentId: agentId,
        intentAnchor: intentAnchor,
        status: taskStatusInput.value,
        conversationId: taskConversationIdInput.value.trim() || null,
        scheduledJobId: taskScheduledJobIdInput.value.trim() || null,
        errorBudget: errorBudget,
        progress: progress,
      };

      tasksSaveBtn.disabled = true;
      setTasksStatus(tasksMode === 'create' ? 'Creating agent task…' : 'Saving agent task…');
      var request = tasksMode === 'create'
        ? fetch('/api/kg/tasks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          })
        : fetch('/api/kg/tasks/' + encodeURIComponent(selectedTaskId), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });

      request
        .then(function(res) {
          return res.json().then(function(body) {
            if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
            return body;
          });
        })
        .then(function() {
          setTasksStatus(tasksMode === 'create' ? 'Agent task created.' : 'Agent task updated.');
          loadTasks();
          if (tasksMode === 'create') resetTaskForm();
        })
        .catch(function(err) { setTasksStatus(err.message || String(err), true); })
        .finally(function() { tasksSaveBtn.disabled = false; });
    }

    function deleteTask() {
      if (!selectedTaskId) return;
      if (!confirm('Delete this agent task? This action cannot be undone.')) return;
      tasksDeleteBtn.disabled = true;
      setTasksStatus('Deleting agent task…');
      fetch('/api/kg/tasks/' + encodeURIComponent(selectedTaskId), { method: 'DELETE' })
        .then(function(res) {
          if (!res.ok) return res.json().then(function(body) { throw new Error(body.error || ('HTTP ' + res.status)); });
        })
        .then(function() {
          setTasksStatus('Agent task deleted.');
          resetTaskForm();
          loadTasks();
        })
        .catch(function(err) { setTasksStatus(err.message || String(err), true); })
        .finally(function() { tasksDeleteBtn.disabled = false; });
    }

    tasksForm.addEventListener('submit', saveTask);
    tasksDeleteBtn.addEventListener('click', deleteTask);
    tasksNewBtn.addEventListener('click', resetTaskForm);
    tasksCancelBtn.addEventListener('click', resetTaskForm);
    tasksSearchBtn.addEventListener('click', filterTasks);
    tasksSearchInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        filterTasks();
      }
    });
    resetTaskForm();

    // ── Scheduled Jobs ───────────────────────────────────────────────
    function setJobsStatus(msg, isError) {
      jobsStatusEl.textContent = msg;
      jobsStatusEl.style.color = isError ? 'var(--destructive)' : 'var(--fg-muted)';
    }

    function resetJobForm() {
      jobsMode = 'create';
      selectedJobId = null;
      jobsEditorTitle.textContent = 'Create Scheduled Job';
      jobsSaveBtn.textContent = 'Create Scheduled Job';
      jobsDeleteBtn.style.display = 'none';
      jobAgentIdInput.value = '';
      jobStatusInput.value = 'pending';
      jobStatusInput.disabled = true;
      jobCronExprInput.value = '';
      jobRunAtInput.value = '';
      jobIntentAnchorInput.value = '';
      jobTaskPayloadInput.value = prettyJson({ kind: 'follow_up', args: {} });
      // Preserve the active search filter when resetting — don't blow away filtered results.
      if (jobsSearchInput.value.trim()) {
        filterJobs();
      } else {
        renderJobsList(jobs);
      }
    }

    function fillJobForm(job) {
      jobsMode = 'edit';
      selectedJobId = job.id;
      jobsEditorTitle.textContent = 'Edit Scheduled Job';
      jobsSaveBtn.textContent = 'Save Changes';
      jobsDeleteBtn.style.display = 'inline-flex';
      jobAgentIdInput.value = job.agentId || '';
      jobStatusInput.value = job.status || 'pending';
      // API only allows setting status back to pending (unsuspend) during PATCH.
      jobStatusInput.disabled = job.status !== 'suspended';
      jobCronExprInput.value = job.cronExpr || '';
      jobRunAtInput.value = job.runAt || '';
      jobIntentAnchorInput.value = job.intentAnchor || '';
      jobTaskPayloadInput.value = prettyJson(job.taskPayload || {});
      // Preserve the active search filter — clicking a card shouldn't un-filter the list.
      if (jobsSearchInput.value.trim()) {
        filterJobs();
      } else {
        renderJobsList(jobs);
      }
    }

    function renderJobsList(list) {
      jobsListEl.replaceChildren();
      if (!list.length) {
        var empty = document.createElement('p');
        empty.style.cssText = 'font-size: 0.8125rem; color: var(--fg-muted); margin: 4px 2px;';
        empty.textContent = 'No scheduled jobs found.';
        jobsListEl.appendChild(empty);
        return;
      }
      list.forEach(function(job) {
        var card = document.createElement('div');
        card.className = 'job-card' + (selectedJobId === job.id ? ' active' : '');
        var title = document.createElement('div');
        title.style.cssText = 'font-size: 0.875rem; font-weight: 600; color: var(--fg);';
        title.textContent = job.agentId + ' · ' + job.status;
        var schedule = document.createElement('div');
        schedule.style.cssText = 'font-size: 0.75rem; color: var(--fg-muted); margin-top: 4px; line-height: 1.35;';
        schedule.textContent = job.cronExpr ? ('Cron: ' + job.cronExpr) : ('Run at: ' + (job.runAt || 'n/a'));
        var meta = document.createElement('div');
        meta.style.cssText = 'font-size: 0.6875rem; color: var(--fg-muted); margin-top: 6px;';
        meta.textContent = 'Next: ' + (job.nextRunAt ? new Date(job.nextRunAt).toLocaleString() : 'n/a');
        card.append(title, schedule, meta);
        card.addEventListener('click', function() { fillJobForm(job); });
        jobsListEl.appendChild(card);
      });
    }

    function loadJobs() {
      setJobsStatus('Loading scheduled jobs…');
      fetchJson('/api/jobs')
        .then(function(data) {
          jobs = data && Array.isArray(data.jobs) ? data.jobs : [];
          if (jobsSearchInput.value.trim()) {
            filterJobs();
          } else {
            renderJobsList(jobs);
            setJobsStatus(jobs.length + ' scheduled job' + (jobs.length === 1 ? '' : 's'));
          }
          if (jobsMode === 'create' && !jobAgentIdInput.value) {
            resetJobForm();
            return;
          }
          if (jobsMode === 'edit') {
            var selected = jobs.find(function(j) { return j.id === selectedJobId; });
            if (selected) {
              fillJobForm(selected);
            } else {
              resetJobForm();
            }
          }
        })
        .catch(function(err) { setJobsStatus(String(err), true); });
    }

    function filterJobs() {
      var q = jobsSearchInput.value.trim().toLowerCase();
      if (!q) {
        renderJobsList(jobs);
        setJobsStatus(jobs.length + ' scheduled job' + (jobs.length === 1 ? '' : 's'));
        return;
      }
      var filtered = jobs.filter(function(job) {
        var intent = job.intentAnchor || '';
        return (job.agentId || '').toLowerCase().includes(q) ||
          (job.status || '').toLowerCase().includes(q) ||
          (job.cronExpr || '').toLowerCase().includes(q) ||
          intent.toLowerCase().includes(q);
      });
      renderJobsList(filtered);
      setJobsStatus(filtered.length + ' result' + (filtered.length === 1 ? '' : 's'));
    }

    function saveJob(e) {
      e.preventDefault();
      var agentId = jobAgentIdInput.value.trim();
      if (!agentId) {
        setJobsStatus('Agent ID is required.', true);
        return;
      }

      var taskPayload;
      try {
        taskPayload = parseJsonField(jobTaskPayloadInput.value, null, 'Task payload');
      } catch (err) {
        setJobsStatus(err.message || String(err), true);
        return;
      }
      if (!taskPayload || typeof taskPayload !== 'object' || Array.isArray(taskPayload)) {
        setJobsStatus('Task payload must be a JSON object.', true);
        return;
      }

      var cronExpr = jobCronExprInput.value.trim();
      var runAt = jobRunAtInput.value.trim();
      if (!cronExpr && !runAt) {
        setJobsStatus('Either cron expression or run at is required.', true);
        return;
      }

      jobsSaveBtn.disabled = true;
      setJobsStatus(jobsMode === 'create' ? 'Creating scheduled job…' : 'Saving scheduled job…');

      var request = jobsMode === 'create'
        ? fetch('/api/jobs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              agent_id: agentId,
              cron_expr: cronExpr || undefined,
              run_at: runAt || undefined,
              task_payload: taskPayload,
              intent_anchor: jobIntentAnchorInput.value.trim() || undefined,
            }),
          })
        : fetch('/api/jobs/' + encodeURIComponent(selectedJobId), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            // The backend treats status='pending' as an unsuspend-only operation and
            // ignores other fields when status is present. Only send the unsuspend
            // payload when the user explicitly selected 'pending'; otherwise send field
            // updates so edits to a suspended job's cron/payload are not silently dropped.
            body: (!jobStatusInput.disabled && jobStatusInput.value === 'pending')
              ? JSON.stringify({ status: 'pending' })
              : JSON.stringify({
                  cron_expr: cronExpr || undefined,
                  run_at: runAt || undefined,
                  task_payload: taskPayload,
                }),
          });

      request
        .then(function(res) {
          return res.json().then(function(body) {
            if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
            return body;
          });
        })
        .then(function() {
          setJobsStatus(jobsMode === 'create' ? 'Scheduled job created.' : 'Scheduled job updated.');
          loadJobs();
          if (jobsMode === 'create') resetJobForm();
        })
        .catch(function(err) { setJobsStatus(err.message || String(err), true); })
        .finally(function() { jobsSaveBtn.disabled = false; });
    }

    function deleteJob() {
      if (!selectedJobId) return;
      if (!confirm('Delete this scheduled job? This action cannot be undone.')) return;
      jobsDeleteBtn.disabled = true;
      setJobsStatus('Deleting scheduled job…');
      fetch('/api/jobs/' + encodeURIComponent(selectedJobId), { method: 'DELETE' })
        .then(function(res) {
          if (!res.ok) return res.json().then(function(body) { throw new Error(body.error || ('HTTP ' + res.status)); });
        })
        .then(function() {
          setJobsStatus('Scheduled job deleted.');
          resetJobForm();
          loadJobs();
        })
        .catch(function(err) { setJobsStatus(err.message || String(err), true); })
        .finally(function() { jobsDeleteBtn.disabled = false; });
    }

    jobsForm.addEventListener('submit', saveJob);
    jobsDeleteBtn.addEventListener('click', deleteJob);
    jobsNewBtn.addEventListener('click', resetJobForm);
    jobsCancelBtn.addEventListener('click', resetJobForm);
    jobsSearchBtn.addEventListener('click', filterJobs);
    jobsSearchInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        filterJobs();
      }
    });
    resetJobForm();

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
        } else if (payload.type === 'message') {
          // Agent reply arrived via SSE — render it only if the POST response
          // hasn't already rendered it (race: whichever fires first wins).
          if (!chatRepliesDelivered.has(convId)) {
            chatRepliesDelivered.add(convId);
            var content = (typeof payload.content === 'string') ? payload.content
                        : JSON.stringify(payload);
            renderMessage('agent', content);
            chatSendBtn.disabled = false;
          }
        }
        // skill.result: not rendered — it's internal bookkeeping for the agent layer.
      };

      chatStream.onerror = function() {
        // CLOSED means a permanent failure (401, 500, etc.) — browser will not retry.
        // CONNECTING means auto-reconnect is in progress — no user action needed.
        if (chatStream && chatStream.readyState === EventSource.CLOSED) {
          renderMessage('error',
            'Live connection lost. Replies will still arrive, but reload the page if updates stop appearing.');
        }
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
      chatSendBtn.disabled = false;
      chatMessagesEl.replaceChildren();
      // Re-render the conversation list to clear the active highlight.
      renderConvList();
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
      // @TODO: if a POST is in-flight for the previous conversation when the user
      // switches, the reply will render into this new conversation's thread instead.
      // Fix: track the active convId per-request and skip render if it doesn't match.
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

      // Capture convId before clearing the reply-delivered flag so the delete
      // is keyed to the right conversation (chatConversationId was just set above).
      var convId = chatConversationId;
      chatRepliesDelivered.delete(convId);
      renderMessage('user', text);
      chatSendBtn.disabled = true;

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
          // Render the reply unless the SSE already did so (race: whichever fires first wins).
          // Use the closure-captured convId to route to the correct conversation even if
          // the user switched threads while this request was in-flight.
          if (!chatRepliesDelivered.has(convId)) {
            chatRepliesDelivered.add(convId);
            var replyText = data.reply || '(no reply)';
            var targetIdx = chatConversations.findIndex(function(c) { return c.id === convId; });
            if (targetIdx >= 0) {
              if (chatActiveConvIdx === targetIdx) {
                // Still on the originating conversation — render to DOM.
                renderMessage('agent', replyText);
              } else {
                // User switched away — persist to the correct history without rendering.
                chatConversations[targetIdx].messages.push({ role: 'agent', text: replyText });
              }
            }
          }
          // Re-enable send only if the user is still in the originating conversation.
          if (chatConversationId === convId) {
            chatSendBtn.disabled = false;
          }
        })
        .catch(function(err) {
          // If the user switched conversations while this request was in-flight, swallow
          // the error silently — surfacing a stale error in the new thread is confusing.
          if (chatConversationId !== convId) return;
          var msg = err.message || '';
          var userMsg;
          // Network-level failure (no response at all)
          if (!msg || msg.toLowerCase().includes('failed to fetch') || msg.includes('NetworkError')) {
            userMsg = 'Could not reach the server. Check your connection and try again.';
          // Non-JSON response body (e.g. HTML 502 from a load balancer)
          } else if (msg.includes('JSON') || msg.toLowerCase().includes('unexpected token')) {
            userMsg = 'Unexpected response from the server. Try reloading the page.';
          } else {
            userMsg = msg;
          }
          renderMessage('error', userMsg);
          chatSendBtn.disabled = false;
        });
    }

    // Allow Shift+Enter for newlines; plain Enter submits the form.
    chatTextarea.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        // Guard against concurrent submits — the button is disabled while a POST
        // is in flight, but the keydown fires before the DOM repaint reflects that.
        if (!chatSendBtn.disabled) sendChatMessage(e);
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
  const { pool, logger, webAppBootstrapSecret, secureCookies, bus, eventRouter, contactService, sessions } = options;
  // sessions is managed by HttpAdapter — no local Map creation needed here.

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
    // Use createRequire so Node's module resolution finds cytoscape relative to
    // this source file, not relative to the compiled bundle output path.
    // The URL-relative approach (new URL('../../../../node_modules/...')) breaks
    // when tsup bundles everything into a flat dist/index.js — the path walks
    // above the project root and produces a 500.
    const require = createRequire(import.meta.url);
    const cytoscapePath = require.resolve('cytoscape/dist/cytoscape.min.js');
    const source = await readFile(cytoscapePath, 'utf8');
    // Long-lived cache — cytoscape is a pinned dependency; the version never
    // changes without a code change, so immutable caching is safe here.
    reply
      .type('application/javascript; charset=utf-8')
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      .send(source);
  });

  // cytoscape-fcose layout extension — requires layout-base and cose-base as UMD globals.
  // All three are served as self-hosted assets using the same createRequire pattern as cytoscape.
  app.get('/assets/layout-base.js', async (_request, reply) => {
    const require = createRequire(import.meta.url);
    const source = await readFile(require.resolve('layout-base/layout-base.js'), 'utf8');
    reply
      .type('application/javascript; charset=utf-8')
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      .send(source);
  });

  app.get('/assets/cose-base.js', async (_request, reply) => {
    const require = createRequire(import.meta.url);
    const source = await readFile(require.resolve('cose-base/cose-base.js'), 'utf8');
    reply
      .type('application/javascript; charset=utf-8')
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      .send(source);
  });

  app.get('/assets/cytoscape-fcose.js', async (_request, reply) => {
    const require = createRequire(import.meta.url);
    const source = await readFile(require.resolve('cytoscape-fcose/cytoscape-fcose.js'), 'utf8');
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

  app.get('/api/kg/tasks', async (request, reply) => {
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

  app.post('/api/kg/tasks', async (request, reply) => {
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
    return reply.status(201).send({
      task: serializeTask(
        inserted.rows[0] as {
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

  app.patch('/api/kg/tasks/:id', async (request, reply) => {
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
    return reply.send({
      task: serializeTask(
        updated.rows[0] as {
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

  app.delete('/api/kg/tasks/:id', async (request, reply) => {
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

  app.get('/api/kg/contacts', async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;
    const contacts = await contactService.listContacts();
    return reply.send({
      contacts: contacts.map((contact) => ({
        id: contact.id,
        kgNodeId: contact.kgNodeId,
        displayName: contact.displayName,
        role: contact.role,
        status: contact.status,
        notes: contact.notes,
        createdAt: contact.createdAt.toISOString(),
        updatedAt: contact.updatedAt.toISOString(),
      })),
    });
  });

  app.post('/api/kg/contacts', async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;
    const body = request.body as {
      displayName?: unknown;
      role?: unknown;
      status?: unknown;
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

    return reply.status(201).send({
      contact: {
        id: created.id,
        kgNodeId: created.kgNodeId,
        displayName: created.displayName,
        role: created.role,
        status: created.status,
        notes: created.notes,
        createdAt: created.createdAt.toISOString(),
        updatedAt: created.updatedAt.toISOString(),
      },
    });
  });

  app.patch('/api/kg/contacts/:id', async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;
    const { id } = request.params as { id: string };
    const body = request.body as {
      displayName?: unknown;
      role?: unknown;
      status?: unknown;
      notes?: unknown;
      kgNodeId?: unknown;
    };
    const contact = await contactService.getContact(id);
    if (!contact) {
      return reply.status(404).send({ error: 'Contact not found.' });
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
      if (!validContactStatuses.includes(body.status as ContactStatus)) {
        return reply.status(400).send({ error: 'Invalid status.' });
      }
      await contactService.setStatus(id, body.status as ContactStatus);
    }

    // Notes and kgNodeId are updated directly by preserving the rest of the contact.
    // This route exists only for the web UI and does not expose generic backend mutation.
    if (typeof body.kgNodeId === 'string' && body.kgNodeId.trim().length > 0 && !UUID_RE.test(body.kgNodeId.trim())) {
      return reply.status(400).send({ error: 'Invalid kgNodeId: must be a valid UUID.' });
    }
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
          typeof body.kgNodeId === 'string' ? body.kgNodeId : body.kgNodeId === null ? null : refreshed.kgNodeId,
          new Date().toISOString(),
        ],
      );
    }

    const updated = await contactService.getContact(id);
    return reply.send({
      contact: updated
        ? {
            id: updated.id,
            kgNodeId: updated.kgNodeId,
            displayName: updated.displayName,
            role: updated.role,
            status: updated.status,
            notes: updated.notes,
            createdAt: updated.createdAt.toISOString(),
            updatedAt: updated.updatedAt.toISOString(),
          }
        : null,
    });
  });

  app.delete('/api/kg/contacts/:id', async (request, reply) => {
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
      return reply.send({ reply: content, conversationId });
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
}
