# Chat View — Design Spec

**Issue:** #779
**Date:** 2026-05-29
**Milestone:** v0.32

## Overview

Port the Chat view to the new React console app (`apps/console/`) as a single-stream `/chat` route. This is the third view migration under issue #670.

The key UX insight driving this design: the user's pain point is **finding history**, not managing conversations. The "conversation" metaphor (as seen in the old UI and the UI kit) implies threading and switching that adds friction without delivering value. Instead, Chat is a single continuous message stream between the principal and the agent — more like a persistent channel than a threaded inbox.

## What We're Building

A `/chat` route that shows:
- A single scrollable message stream (all messages from the current session)
- A pinned composer at the bottom (textarea + Send button)
- Live status messages as the agent processes (skill invocations, autonomy band announcements)

No conversation list. No conversation switching. No per-conversation routes.

## What We're Not Building (Future Work)

- Persistent history across page reloads (no DB-backed conversation log yet)
- Pre-loading recent history on mount
- Search or filtering of past messages

## Route Structure

```
/chat   →  ChatPage (single stream, always)
```

No nested routes. `/chat` is the only Chat route. When the user navigates away and returns, the in-session state is preserved as long as the React tree is mounted; a full reload starts fresh.

## Component Architecture

All new files live in `apps/console/src/`:

```
pages/
  ChatPage.tsx          — page shell: Sidebar + Topbar + chat layout, owns useChatSession
  chat/
    ChatThread.tsx      — renders the message list; auto-scrolls to bottom on new messages
    ChatComposer.tsx    — textarea + Send button
    useChatSession.ts   — hook: all state, one conversationId per session, API calls
    types.ts            — Message type (kind, id, text)
```

### Modified files

| File | Change |
|---|---|
| `router.tsx` | Add `/chat` route (lazy-loaded `ChatPage`) under `authedRoute` |
| `components/Sidebar.tsx` | Wire Chat nav item to `navigate({ to: '/chat' })` via TanStack Router |
| `styles/app.css` | Add chat layout CSS classes |
| `src/channels/http/routes/kg.ts` | Add `GET /old/chat` redirect → `/chat` |

## Data Model

```typescript
// apps/console/src/pages/chat/types.ts
type MessageKind = 'user' | 'agent' | 'status' | 'error';

interface Message {
  id: string;         // crypto.randomUUID() — stable React key
  kind: MessageKind;
  text: string;
}
```

## API

Uses the existing web-channel endpoints, which are session-cookie authenticated and resolve to the CEO principal:

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/kg/chat/messages` | POST | Send a message; wait for agent reply |
| `/api/kg/chat/stream` | GET (SSE) | Receive skill.invoke and status events in real-time |

**POST body:** `{ message: string, conversationId: string }`
**POST response:** `{ reply: string, conversationId: string }`
**SSE filter:** `?conversationId=<id>`

## useChatSession Hook

Owns all chat state. Lifecycle per send:

1. Generate one `conversationId` on first send (reused for the entire session).
2. Append the user's message to state immediately (optimistic UI).
3. Open an `EventSource` on `/api/kg/chat/stream?conversationId=<id>` **before** the POST to avoid racing a fast reply.
4. POST to `/api/kg/chat/messages`.
5. As SSE events arrive, append `status` messages to state in real-time.
6. When the POST resolves, append the `agent` reply and close the `EventSource`.
7. On POST failure (network error, timeout, 4xx/5xx), append an `error` message and close the `EventSource`.
8. Disable the composer while a reply is in-flight; re-enable on resolution.

The `EventSource` is scoped to a single send cycle — it is opened just before the POST and closed immediately after. No persistent SSE connection is maintained.

## Message Visual Treatment

| Kind | Alignment | Styling |
|---|---|---|
| `user` | Right | Dark bubble (`--app-card-elev`), rounded corners (12px 12px 2px 12px) |
| `agent` | Left | Card bubble with border (`--app-border`), rounded corners (12px 12px 12px 2px) |
| `status` | Center | Small italic text in `--app-fg-subtle`; no bubble |
| `error` | Center | Small text in `--app-destructive`; no bubble |

## Routing — `/old/chat` Removal

Since `/old/*` is a single Fastify wildcard handler serving the monolithic old UI, individual paths cannot be surgically removed from it. Instead, add a specific `GET /old/chat` route in `kg.ts` **before** the `GET /old/*` wildcard registration. Fastify's radix router gives exact matches priority over wildcards.

```typescript
// In knowledgeGraphRoutes(), before the existing /old/* handler:
app.get('/old/chat', (_req, reply) => reply.redirect('/chat'));
```

## Layout CSS

New classes added to `styles/app.css`:

```
.chat-page        — flex column, fills .main, overflow hidden
.chat-messages    — flex 1, overflow-y auto, padding 20px 24px, flex-column gap 10px
.msg-bubble       — base; width fit-content, max-width 68%, line-height 1.5
.msg-bubble.user  — align-self flex-end, background --app-card-elev, rounded 12px 12px 2px 12px
.msg-bubble.agent — align-self flex-start, background --app-card, border 1px --app-border, rounded 12px 12px 12px 2px
.msg-bubble.status — align-self center, max-width 100%, font-size 11px, italic, color --app-fg-subtle
.msg-bubble.error  — align-self center, max-width 100%, font-size 11px, color --app-destructive
.chat-composer    — flex none, padding 12px 20px, border-top 1px --app-border, display flex, gap 10px, align-items flex-end
.chat-composer textarea — flex 1, resize none, min-height 42px, max-height 160px
```

## Mobile

No additional structural changes needed. The chat layout is a simple vertical flex column:

- The app sidebar collapses to the existing hamburger overlay (unchanged).
- The message stream fills the viewport, the composer is pinned to the bottom.
- The composer textarea remains accessible above the keyboard (standard browser behavior with `position: sticky` / `flex: none`).

## Acceptance Criteria (from #779)

- [x] Chat accessible at `/chat`
- [x] New message input, send, and receive work end-to-end
- [x] Live status messages (skill.invoke, autonomy band) shown in real-time via SSE
- [x] Design system applied (tokens from `app.css`, Topbar + Sidebar reused)
- [x] Browser back/forward navigates correctly to/from Chat
- [x] `GET /old/chat` redirects to `/chat`
- [x] Mobile viewport: chat is usable end-to-end (stream scrolls, input accessible)
