# Web-console chat: ack-and-stream (remove the synchronous 120s wait)

**Issue:** [#985](https://github.com/josephfung/curia/issues/985)
**Date:** 2026-06-15
**Status:** Design approved, ready for implementation plan

## Problem

`POST /api/kg/chat/messages` waits **synchronously** for the entire agent
response via `waitForResponse(conversationId, CHAT_RESPONSE_TIMEOUT_MS = 120_000)`
and only returns once the full reply is ready
([kg.ts:1059-1127](../../src/channels/http/routes/kg.ts#L1059-L1127)). Many normal
web-console tasks — browser automation, multi-agent delegation chains, research —
routinely exceed 120s. When they do, the user gets a 504 even though the agent is
still working and will eventually answer. This is a **common, expected case**, not
an edge case: the first real-world test of the web-browser + secrets feature hit it
immediately (a coordinator turn fanning out two delegate sub-agents ran past 120s).

The architecture already has the right plumbing: `GET /api/kg/chat/stream` is an
SSE endpoint that broadcasts `outbound.message`, `skill.invoke`, `skill.result`,
and `message.rejected` events with a 30s heartbeat
([kg.ts:1135+](../../src/channels/http/routes/kg.ts#L1135)). The POST just shouldn't
block on the full response when the stream can deliver it.

## Chosen approach: Option 1 — ack + stream

POST returns `202 { conversationId }` immediately once the inbound message is
published. The final reply and intermediate events arrive over the existing SSE
stream, which becomes the **source of truth** for the final assistant message.
This removes the synchronous timeout entirely and surfaces progress during long
tasks.

Two design forks were resolved during brainstorming:

- **POST contract → full async (202-only).** No opt-in synchronous mode. The reply
  is delivered only over SSE (or recoverable via `/api/kg/chat/history`).
  Programmatic callers that previously read `reply` from the POST body must consume
  the stream or the history endpoint. This keeps a single code path and fully
  removes the 120s timeout path from this route.
- **HTML rendering → server-side in the SSE event.** The `outbound.message` SSE
  payload currently carries markdown only; the old POST path rendered HTML via
  `markdownToHtml`. We add an `html` field to the `message` SSE payload in
  `event-router.ts` so the frontend keeps rendering server-produced HTML with no
  new client dependency, consistent with the POST and `/history` paths.

## Current behavior (baseline)

### Backend
- **POST** registers a waiter *before* publishing, awaits a `WaitResult`
  discriminated union, and maps outcomes to HTTP status:
  `ok → 200 { reply, html, conversationId }`, `timeout → 504`,
  `rejected → 403/429` (via `mapWaitFailureToHttp`), `superseded → 500`.
- **SSE** (`addSseClient` in
  [event-router.ts](../../src/channels/http/event-router.ts)) broadcasts, filtered
  by `conversationId`:
  - `outbound.message` → `{ type: 'message', conversation_id, content, timestamp }`
    — **markdown only**, no HTML.
  - `skill.invoke` → `{ type: 'skill.invoke', agent, skill, conversation_id, timestamp }`
  - `skill.result` → `{ type: 'skill.result', agent, skill, success, duration_ms, conversation_id, timestamp }`
  - `message.rejected` → `{ type: 'message.rejected', conversation_id, channel_id, sender_id, reason, timestamp }`
- **Cardinality:** exactly one `outbound.message` per agent turn, *except* the rare
  case where a human-facing skill (email-reply/email-send) already fired during the
  turn — then the outbound is suppressed (`outbound.suppressed_duplicate`) and no
  `message` event reaches the stream.
- **Errors:** a failed agent turn still surfaces as an `outbound.message` carrying
  the error text as content (so it renders like a normal reply). `agent.error` is
  *not* broadcast to SSE.

### Frontend (`apps/console/src/pages/chat/`)
- `useChatSession.ts` already opens the `EventSource` **before** the POST, but only
  renders `skill.invoke` as status lines and treats the **POST response body** as
  the source of truth for the final reply. The `message` SSE event is ignored
  (`parseSseEvent` returns `null` for it).
- `conversationId` is `crypto.randomUUID()` persisted in `localStorage`
  (`curia:chat:conversationId`).

## Target design

### 1. Backend — `POST /api/kg/chat/messages` (`src/channels/http/routes/kg.ts`)

- Remove `waitForResponse`, the `cancelPending` call, and the entire
  `WaitResult` / `mapWaitFailureToHttp` post-resolution block from this route.
- After a successful `bus.publish`, return **`202 { conversationId }`**.
- Retain: `assertSecret` guard (401), empty-message **400**, **503** when
  `webAppBootstrapSecret` is undefined, and **500** on a synchronous publish
  failure.
- Remove `CHAT_RESPONSE_TIMEOUT_MS` and `mapWaitFailureToHttp` imports **iff** they
  become unused in this file (they remain in `messages.ts`, which is untouched).

### 2. Backend — SSE `outbound.message` branch (`src/channels/http/event-router.ts`)

- In the `outbound.message` → SSE serialization, add an `html` field rendered via
  `markdownToHtml(event.payload.content)`, alongside the existing `content`
  (markdown retained for non-HTML consumers).
- Wrap the render in try/catch: on failure, emit `html: null` and log a warning
  (mirrors the existing graceful-fallback pattern in `kg.ts`). A render error must
  never drop the message event.
- Additive change: `/api/messages/stream` consumers ignore the new field.

### 3. Frontend — `apps/console/src/pages/chat/`

- **Race fix (`useChatSession.ts`):** gate the POST on the SSE connection being
  live. Open `EventSource`, await `onopen`, *then* issue the POST. This closes the
  window where a fast reply is broadcast before the stream is registered
  server-side — now critical, since the stream is the only delivery path.
- **`parseSseEvent` (`chat-utils.ts`):** extend to handle:
  - `message` → return the final agent message (`content` + `html`) as a terminal
    result.
  - `message.rejected` → return terminal error text derived from `reason`.
  - `skill.invoke` → unchanged status line.
- **`useChatSession.ts` send flow:** the POST response is now just an ack (expect
  202; non-2xx → error). The **`message` SSE event becomes the source of truth** for
  the final reply. On a terminal event (`message` or `message.rejected`): render it,
  clear the `sending` state, close the stream. Long tasks (>120s) keep streaming
  with **no client-side cliff**.
- **Hang safety (soft recovery):** the only no-terminal-event cases are the rare
  suppressed-duplicate turn or an agent crash. After **5 minutes** with no terminal
  event, the client fetches `/api/kg/chat/history?conversationId=...` once to recover
  any assistant reply that landed; if one is found, render it and finish. If still
  nothing, show a soft, non-error "still working — check back" notice and **leave
  the stream open** (no hard failure that would kill a legitimately long task). The
  5-minute cap is a named constant for easy tuning.

### 4. Tests

- **`tests/unit/channels/http/kg-chat-routes.test.ts`:** rewrite the POST cases.
  Assert **202 + `{ conversationId }`**, that `bus.publish` was called, and that
  `waitForResponse` is **not** called. Keep 401 (no auth), 400 (empty message), 503
  (no bootstrap secret), and 500 (synchronous publish failure). Drop the
  504/403/429/500-supersede sync-mapping cases for *this* route.
- **`tests/unit/channels/http/event-router.test.ts`:** assert the `message` SSE
  payload now includes a rendered `html` field, and that a `markdownToHtml` failure
  degrades to `html: null` without dropping the event.
- **Frontend:** add/adjust coverage for `parseSseEvent` (new `message` /
  `message.rejected` handling) and the `useChatSession` terminal-event + onopen-gate
  flow, matching whatever test setup already exists in `apps/console`.

## Acceptance criteria (from #985)

- A web-console chat task that takes >120s completes and shows its result without an
  error. ✔ (no synchronous timeout; reply delivered over SSE)
- No single chat turn ties up a server connection for minutes. ✔ (POST returns 202
  immediately)
- Intermediate progress (skill invocations / delegate steps) is visible during long
  tasks. ✔ (`skill.invoke` status lines already render; stream stays open)
- Fast (<5s) chats still feel synchronous. ✔ (onopen-gated POST + SSE terminal
  event delivered immediately)

## Out of scope / notes

- **#983 (uncaught-rejection hardening) is independent.** This route no longer
  registers a waiter, so the supersede-reject path is moot *here*, but `messages.ts`
  still uses `waitForResponse` and #983 remains its own work.
- No changes to `messages.ts`, the dispatcher, or the bus event definitions.
- `outbound.suppressed_duplicate` is *not* added to the SSE broadcast in this change;
  the soft `/history` recovery covers that case without new bus plumbing.

## Risks

- **Race on fast replies** if the onopen gate is wrong — mitigated by gating the
  POST on `EventSource.onopen` and the `/history` recovery fallback.
- **API-contract break** for programmatic POST callers reading `reply` from the body
  — accepted per the chosen "full async" decision; tests updated accordingly.
