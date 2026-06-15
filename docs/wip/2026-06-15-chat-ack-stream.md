# Web-console chat ack-and-stream Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `POST /api/kg/chat/messages` from blocking on the agent's full reply; ack immediately with `202`, deliver the reply (and progress) over the existing SSE stream.

**Architecture:** The POST publishes the inbound message and returns `202 { conversationId }`. The `outbound.message` SSE event becomes the source of truth for the final reply and now carries server-rendered `html`. The console opens the SSE stream, waits for it to connect, POSTs, then renders the final reply from the stream's terminal event. A 5-minute client watchdog recovers a missed reply via `/history` and otherwise shows a soft "still working" notice without killing long tasks.

**Tech Stack:** TypeScript (ESM), Fastify, Node SSE, React (Vite), Vitest.

**Design reference:** [docs/wip/2026-06-15-chat-ack-stream-design.md](2026-06-15-chat-ack-stream-design.md) · Issue [#985](https://github.com/josephfung/curia/issues/985)

**Worktree:** `/Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-chat-ack-stream` (branch `feat/chat-ack-stream`). All commands below assume this worktree via `pnpm -C` / `git -C`.

---

## File Structure

- **Modify** `src/channels/http/event-router.ts` — add rendered `html` to the `outbound.message` → SSE payload.
- **Modify** `tests/unit/channels/http/event-router.test.ts` — add SSE-broadcast coverage (html present + render-failure fallback).
- **Modify** `src/channels/http/routes/kg.ts` — POST becomes a `202` ack; remove `waitForResponse`/wait-mapping; prune now-unused imports.
- **Modify** `tests/unit/channels/http/kg-chat-routes.test.ts` — rewrite POST cases for the ack contract.
- **Modify** `apps/console/src/pages/chat/types.ts` — add `SseEvent` discriminated union and shared `HistoryMessage` type.
- **Modify** `apps/console/src/pages/chat/chat-utils.ts` — `parseSseEvent` returns `SseEvent | null`; add `pickRecoveredReply`.
- **Modify** `apps/console/src/pages/chat/chat-utils.test.ts` — rewrite `parseSseEvent` cases; add `pickRecoveredReply` cases.
- **Modify** `apps/console/src/pages/chat/useChatSession.ts` — ack+stream send flow: onopen-gated POST, terminal-event finish, watchdog recovery.
- **Modify** `CHANGELOG.md` — one `Changed` bullet.

---

## Task 1: SSE `outbound.message` event carries rendered HTML

**Files:**
- Modify: `src/channels/http/event-router.ts:160-169`
- Test: `tests/unit/channels/http/event-router.test.ts`

- [ ] **Step 1: Write the failing tests**

Add this block at the end of `tests/unit/channels/http/event-router.test.ts` (before the final newline; after the existing `describe('EventRouter.waitForResponse', ...)` block). It uses a mock SSE client whose `res.write` captures the serialized frame.

```typescript
describe('EventRouter SSE — outbound.message html rendering', () => {
  it('includes server-rendered html alongside markdown content', () => {
    const { router, emit } = makeRouter();
    const writes: string[] = [];
    const res = { write: (chunk: string) => { writes.push(chunk); return true; } };
    router.addSseClient({ res: res as unknown as ServerResponse, conversationId: 'c1' });

    emit({
      type: 'outbound.message',
      timestamp: '2026-06-15T00:00:00.000Z',
      payload: { channelId: 'web', conversationId: 'c1', content: 'hello **world**' },
    } as unknown as BusEvent);

    // The SSE frame is `data: <json>\n\n`. Strip the prefix/suffix and parse.
    const frame = writes.find((w) => w.startsWith('data: '));
    expect(frame).toBeDefined();
    const payload = JSON.parse(frame!.slice('data: '.length).trim()) as {
      type: string; content: string; html: string | null;
    };
    expect(payload.type).toBe('message');
    expect(payload.content).toBe('hello **world**');
    expect(payload.html).toContain('<strong>world</strong>');
  });

  it('falls back to html: null when markdown rendering throws', () => {
    const { router, emit } = makeRouter();
    const writes: string[] = [];
    const res = { write: (chunk: string) => { writes.push(chunk); return true; } };
    router.addSseClient({ res: res as unknown as ServerResponse, conversationId: 'c2' });

    // A non-string content slips past the type system via the cast and makes
    // markdownToHtml throw; the event must still be delivered with html: null.
    emit({
      type: 'outbound.message',
      timestamp: '2026-06-15T00:00:00.000Z',
      payload: { channelId: 'web', conversationId: 'c2', content: { not: 'a string' } },
    } as unknown as BusEvent);

    const frame = writes.find((w) => w.startsWith('data: '));
    expect(frame).toBeDefined();
    const payload = JSON.parse(frame!.slice('data: '.length).trim()) as { html: string | null };
    expect(payload.html).toBeNull();
  });
});
```

Add the `ServerResponse` type import at the top of the test file (after the existing imports):

```typescript
import type { ServerResponse } from 'node:http';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-chat-ack-stream test tests/unit/channels/http/event-router.test.ts`
Expected: FAIL — the first test fails because `payload.html` is `undefined` (field not emitted yet); the second also fails on `html` being absent.

- [ ] **Step 3: Implement the html field**

In `src/channels/http/event-router.ts`, add the import near the other imports at the top of the file:

```typescript
import { markdownToHtml } from '../../utils/markdown-to-html.js';
```

Then replace the `outbound.message` SSE serialization block (currently lines 160-169) with:

```typescript
      // Stream to all SSE clients (filtered by conversationId if set).
      // Wrap writes in try/catch so a dead client doesn't abort delivery
      // to the remaining clients in this dispatch cycle.
      //
      // Render markdown→HTML server-side so the SSE consumer (the web console)
      // gets the same pre-rendered HTML the POST path used to return. Wrapped in
      // try/catch: a render failure must degrade to html: null, never drop the
      // message event. (#985)
      let html: string | null = null;
      try {
        html = markdownToHtml(event.payload.content);
      } catch (renderErr) {
        this.logger.warn({ err: renderErr, conversationId: convId }, 'markdownToHtml failed for SSE message; sending html: null');
      }
      const sseData = JSON.stringify({
        type: 'message',
        conversation_id: convId,
        content: event.payload.content,
        html,
        timestamp: event.timestamp,
      });
      this.broadcastToSseClients(sseData, convId);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-chat-ack-stream test tests/unit/channels/http/event-router.test.ts`
Expected: PASS (all tests in the file, including the existing `waitForResponse` cases).

- [ ] **Step 5: Typecheck**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-chat-ack-stream run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-chat-ack-stream add src/channels/http/event-router.ts tests/unit/channels/http/event-router.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-chat-ack-stream commit -m "feat: render html in outbound.message SSE payload (#985)"
```

---

## Task 2: POST `/api/kg/chat/messages` returns a 202 ack

**Files:**
- Modify: `src/channels/http/routes/kg.ts` (imports line 10, constant line 36, handler lines 1059-1127)
- Test: `tests/unit/channels/http/kg-chat-routes.test.ts`

- [ ] **Step 1: Rewrite the POST test cases (failing)**

In `tests/unit/channels/http/kg-chat-routes.test.ts`:

(a) Simplify the mock EventRouter — it no longer needs `waitForResponse`/`cancelPending` for the POST path, but keep them harmless for other call sites. Replace `createMockEventRouter` (lines 37-44) with:

```typescript
// The ack-and-stream POST no longer calls waitForResponse; it only publishes and
// returns 202. We keep addSseClient/setupSubscriptions for the stream route wiring.
function createMockEventRouter(): EventRouter {
  return {
    waitForResponse: vi.fn(),
    cancelPending: vi.fn(),
    addSseClient: vi.fn().mockReturnValue(() => { /* cleanup noop */ }),
    setupSubscriptions: vi.fn(),
  } as unknown as EventRouter;
}
```

Update the two call sites that passed an argument (`createMockEventRouter('Hey there!')` at line 109 and `createMockEventRouter('reply')` at line 167) to `createMockEventRouter()`.

The `MessageRejectedError` import (line 16) becomes unused after removing the 403 case below — drop it from the import, leaving `import { type EventRouter } from '../../../../src/channels/http/event-router.js';`.

(b) Replace the happy-path test (lines 107-139) with the ack assertion:

```typescript
  it('POST /api/kg/chat/messages — 202 ack with valid bootstrap-secret header', async () => {
    const bus = createMockBus();
    const eventRouter = createMockEventRouter();

    const app = Fastify();
    await app.register(cookie);
    await app.register(knowledgeGraphRoutes, {
      pool: createPool() as Pool,
      logger: createLogger(),
      webAppBootstrapSecret: 'test-secret',
      secureCookies: false,
      bus,
      eventRouter,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/kg/chat/messages',
      headers: { 'x-web-bootstrap-secret': 'test-secret' },
      payload: { message: 'What is on the agenda?', conversationId: 'test-convo-1' },
    });

    expect(response.statusCode).toBe(202);
    const body = response.json();
    expect(body.conversationId).toBe('test-convo-1');
    // The reply now arrives over SSE, not in the POST body.
    expect(body.reply).toBeUndefined();

    // The inbound message was published; the handler does NOT block on a reply.
    expect(bus.publish).toHaveBeenCalledOnce();
    expect(eventRouter.waitForResponse).not.toHaveBeenCalled();

    await app.close();
  });
```

(c) Replace the auto-generates-conversationId test (lines 165-197) body's assertions: change `expect(response.statusCode).toBe(200)` → `toBe(202)`, and replace the final `waitForResponse` assertion with:

```typescript
    expect(response.statusCode).toBe(202);
    const body = response.json();
    expect(typeof body.conversationId).toBe('string');
    expect(body.conversationId.length).toBeGreaterThan(0);
    expect(eventRouter.waitForResponse).not.toHaveBeenCalled();
```

(d) Delete the four wait-mapping tests that no longer apply to this route: the 504 timeout (lines 202-231), the 403 rejected (233-265), the 429 rate-limited (267-301), and the 500 superseded (303-331) cases. Their behavior now lives on the SSE path / is gone with the synchronous wait.

(e) Add a publish-failure test (insert after the empty-message 400 test, around line 163):

```typescript
  it('POST /api/kg/chat/messages — 500 when publish fails synchronously', async () => {
    const bus = {
      publish: vi.fn().mockRejectedValue(new Error('bus down')),
      subscribe: vi.fn(),
    } as unknown as EventBus;

    const app = Fastify();
    await app.register(cookie);
    await app.register(knowledgeGraphRoutes, {
      pool: createPool() as Pool,
      logger: createLogger(),
      webAppBootstrapSecret: 'test-secret',
      secureCookies: false,
      bus,
      eventRouter: createMockEventRouter(),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/kg/chat/messages',
      headers: { 'x-web-bootstrap-secret': 'test-secret' },
      payload: { message: 'hello', conversationId: 'c-fail' },
    });

    expect(response.statusCode).toBe(500);
    await app.close();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-chat-ack-stream test tests/unit/channels/http/kg-chat-routes.test.ts`
Expected: FAIL — the 202 tests fail because the handler still returns 200 with a `reply` body and still calls `waitForResponse`.

- [ ] **Step 3: Rewrite the POST handler**

In `src/channels/http/routes/kg.ts`, replace the handler body (lines 1059-1127, from `app.post('/api/kg/chat/messages', ...` through its closing `});`) with the ack implementation:

```typescript
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
      const message = publishErr instanceof Error ? publishErr.message : String(publishErr);
      logger.error({ err: publishErr, conversationId }, 'KG chat message publish failed');
      return reply.status(500).send({ error: message });
    }

    // Ack: the reply is delivered over the SSE stream, not this response.
    return reply.status(202).send({ conversationId });
  });
```

- [ ] **Step 4: Prune now-unused imports and constant**

In `src/channels/http/routes/kg.ts`:
- Line 10: change `import { type EventRouter, mapWaitFailureToHttp } from '../event-router.js';` → `import type { EventRouter } from '../event-router.js';` (`mapWaitFailureToHttp` is no longer used in this file).
- Line 36: delete `const CHAT_RESPONSE_TIMEOUT_MS = 120_000;` (no longer referenced).
- Leave `markdownToHtml` (line 12) — still used by the `/history` route.

- [ ] **Step 5: Run the tests + typecheck to verify they pass**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-chat-ack-stream test tests/unit/channels/http/kg-chat-routes.test.ts`
Expected: PASS.
Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-chat-ack-stream run typecheck`
Expected: no errors (confirms no dangling references to the removed import/constant).

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-chat-ack-stream add src/channels/http/routes/kg.ts tests/unit/channels/http/kg-chat-routes.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-chat-ack-stream commit -m "feat: POST /api/kg/chat/messages acks with 202 instead of blocking (#985)"
```

---

## Task 3: Frontend SSE parsing — `parseSseEvent` returns a discriminated event + recovery helper

**Files:**
- Modify: `apps/console/src/pages/chat/types.ts`
- Modify: `apps/console/src/pages/chat/chat-utils.ts`
- Test: `apps/console/src/pages/chat/chat-utils.test.ts`

- [ ] **Step 1: Add shared types**

In `apps/console/src/pages/chat/types.ts`, append:

```typescript
/**
 * A parsed SSE event from GET /api/kg/chat/stream, normalized for the chat UI.
 * - status:   intermediate progress (skill invocation) — append as a status line.
 * - reply:    the agent's final reply for this turn (terminal).
 * - rejected: the turn was rejected before reaching the agent (terminal error).
 * parseSseEvent returns null for everything else (skill.result, malformed, etc.).
 */
export type SseEvent =
  | { kind: 'status'; text: string }
  | { kind: 'reply'; text: string; html: string | null }
  | { kind: 'rejected'; text: string };

/** A chat history row as returned by GET /api/kg/chat/history. */
export interface HistoryMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  html: string | null;
  timestamp: string;
}
```

- [ ] **Step 2: Rewrite the `parseSseEvent` tests (failing)**

In `apps/console/src/pages/chat/chat-utils.test.ts`, replace the entire `describe('parseSseEvent', ...)` block (lines 4-43) with:

```typescript
describe('parseSseEvent', () => {
  it('returns a status event for skill.invoke', () => {
    const data = JSON.stringify({ type: 'skill.invoke', skill: 'memory.recall', conversation_id: 'c1' });
    expect(parseSseEvent(data)).toEqual({ kind: 'status', text: 'invoking memory.recall' });
  });

  it('falls back to "skill" when the skill field is absent', () => {
    const data = JSON.stringify({ type: 'skill.invoke', conversation_id: 'c1' });
    expect(parseSseEvent(data)).toEqual({ kind: 'status', text: 'invoking skill' });
  });

  it('returns a reply event with content and html for message events', () => {
    const data = JSON.stringify({ type: 'message', content: 'Hello', html: '<p>Hello</p>' });
    expect(parseSseEvent(data)).toEqual({ kind: 'reply', text: 'Hello', html: '<p>Hello</p>' });
  });

  it('returns a reply event with html: null when html is absent', () => {
    const data = JSON.stringify({ type: 'message', content: 'Hi' });
    expect(parseSseEvent(data)).toEqual({ kind: 'reply', text: 'Hi', html: null });
  });

  it('returns a rejected event with friendly text for message.rejected', () => {
    const data = JSON.stringify({ type: 'message.rejected', reason: 'global_rate_limited' });
    const result = parseSseEvent(data);
    expect(result?.kind).toBe('rejected');
    if (result?.kind !== 'rejected') throw new Error('expected rejected');
    expect(result.text).toMatch(/rate limit/i);
  });

  it('returns null for skill.result events (not displayed)', () => {
    expect(parseSseEvent(JSON.stringify({ type: 'skill.result', skill: 'memory.recall' }))).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseSseEvent('not-json')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseSseEvent('')).toBeNull();
  });

  it('returns null for non-object JSON', () => {
    expect(parseSseEvent('42')).toBeNull();
    expect(parseSseEvent('"hello"')).toBeNull();
  });
});

describe('pickRecoveredReply', () => {
  const sentAt = new Date('2026-06-15T12:00:00Z').getTime();

  it('returns the most recent assistant reply that landed at or after the send time', () => {
    const items = [
      { id: '1', role: 'user' as const, content: 'q', html: null, timestamp: '2026-06-15T11:59:00Z' },
      { id: '2', role: 'assistant' as const, content: 'old', html: null, timestamp: '2026-06-15T11:59:30Z' },
      { id: '3', role: 'user' as const, content: 'q2', html: null, timestamp: '2026-06-15T12:00:00Z' },
      { id: '4', role: 'assistant' as const, content: 'fresh', html: '<p>fresh</p>', timestamp: '2026-06-15T12:03:00Z' },
    ];
    expect(pickRecoveredReply(items, sentAt)).toEqual({ text: 'fresh', html: '<p>fresh</p>' });
  });

  it('returns null when no assistant reply landed after the send time', () => {
    const items = [
      { id: '1', role: 'user' as const, content: 'q', html: null, timestamp: '2026-06-15T12:00:00Z' },
      { id: '2', role: 'assistant' as const, content: 'stale', html: null, timestamp: '2026-06-15T11:00:00Z' },
    ];
    expect(pickRecoveredReply(items, sentAt)).toBeNull();
  });

  it('returns null for an empty history page', () => {
    expect(pickRecoveredReply([], sentAt)).toBeNull();
  });
});
```

Update the import on line 2 to include `pickRecoveredReply`:

```typescript
import { parseSseEvent, makeMessage, formatTimestamp, linkifyText, pickRecoveredReply } from './chat-utils.js';
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-chat-ack-stream test apps/console/src/pages/chat/chat-utils.test.ts`
Expected: FAIL — `parseSseEvent` still returns strings/null and `pickRecoveredReply` does not exist.

- [ ] **Step 4: Implement the new `parseSseEvent` and `pickRecoveredReply`**

In `apps/console/src/pages/chat/chat-utils.ts`, update the import on line 1:

```typescript
import type { Message, SseEvent, HistoryMessage } from './types.js';
```

Replace the existing `parseSseEvent` function (lines 3-25) with:

```typescript
/**
 * Friendly, user-facing text for a message.rejected reason code.
 * Falls back to a generic message naming the reason for unrecognized codes.
 */
function rejectionText(reason: string): string {
  switch (reason) {
    case 'global_rate_limited':
    case 'rate_limited':
      return 'Rate limit reached. Please wait a moment and try again.';
    case 'message_too_large':
      return 'That message is too large to process.';
    default:
      return `Message rejected (${reason}).`;
  }
}

/**
 * Parses a raw SSE event data string from GET /api/kg/chat/stream into a
 * normalized SseEvent, or null for events the chat UI ignores.
 *
 * Ack-and-stream (#985): the POST only acks, so the `message` event is now the
 * source of truth for the agent's final reply (terminal). `message.rejected` is
 * a terminal error. `skill.invoke` is intermediate progress. Everything else
 * (skill.result, malformed payloads, unknown types) returns null.
 */
export function parseSseEvent(data: string): SseEvent | null {
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch (parseErr) {
    // Non-fatal: malformed SSE data is silently ignored.
    // Log at debug level so it's visible in DevTools when investigating SSE issues.
    console.debug('[parseSseEvent] failed to parse SSE data:', parseErr);
    return null;
  }
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;

  switch (p['type']) {
    case 'skill.invoke': {
      const skill = typeof p['skill'] === 'string' ? p['skill'] : 'skill';
      return { kind: 'status', text: `invoking ${skill}` };
    }
    case 'message': {
      const text = typeof p['content'] === 'string' ? p['content'] : '';
      const html = typeof p['html'] === 'string' ? p['html'] : null;
      return { kind: 'reply', text, html };
    }
    case 'message.rejected': {
      const reason = typeof p['reason'] === 'string' ? p['reason'] : 'unknown';
      return { kind: 'rejected', text: rejectionText(reason) };
    }
    default:
      return null;
  }
}

/**
 * Recovery helper for the client watchdog: given a page of chat history (oldest
 * first) and the time we sent the current turn, return the most recent assistant
 * reply that landed at or after the send time — the reply we may have missed if
 * the SSE message event never arrived. Returns null if there's no such reply.
 */
export function pickRecoveredReply(
  items: HistoryMessage[],
  sentAtMs: number,
): { text: string; html: string | null } | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const m = items[i]!;
    if (m.role === 'assistant' && new Date(m.timestamp).getTime() >= sentAtMs) {
      return { text: m.content, html: m.html };
    }
  }
  return null;
}
```

- [ ] **Step 5: Run the tests + typecheck to verify they pass**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-chat-ack-stream test apps/console/src/pages/chat/chat-utils.test.ts`
Expected: PASS.
Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-chat-ack-stream/apps/console run typecheck`
Expected: errors only in `useChatSession.ts` (it still references the old `parseSseEvent` string contract and the local `HistoryMessage` type) — those are fixed in Task 4. If you see errors elsewhere, fix before continuing.

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-chat-ack-stream add apps/console/src/pages/chat/types.ts apps/console/src/pages/chat/chat-utils.ts apps/console/src/pages/chat/chat-utils.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-chat-ack-stream commit -m "feat: parse terminal SSE events + history recovery helper for chat console (#985)"
```

---

## Task 4: Frontend `useChatSession` — ack+stream send flow

**Files:**
- Modify: `apps/console/src/pages/chat/useChatSession.ts`

No unit test is added for the hook itself: `apps/console` runs under the `node` Vitest environment with no React/DOM test harness (no `@testing-library/react`, no jsdom, no `EventSource`/`localStorage` polyfills). The testable logic (SSE parsing, reply recovery) was extracted into `chat-utils` and covered in Task 3. The hook wiring is verified here via typecheck + production build, and manually in Task 5. **Coverage gap to flag in the PR:** the onopen gate, terminal-event finalize, and watchdog timing are not unit-tested; introducing a React test harness for `apps/console` is worth a follow-up issue.

- [ ] **Step 1: Replace the local `HistoryMessage` interface with the shared type**

In `apps/console/src/pages/chat/useChatSession.ts`:
- Update the import on line 5 to: `import type { Message, HistoryMessage } from './types.js';`
- Delete the local `interface HistoryMessage { ... }` (lines 24-30). Keep `interface HistoryResponse` (lines 32-35) as-is.

- [ ] **Step 2: Add constants for the watchdog and onopen gate**

In `apps/console/src/pages/chat/useChatSession.ts`, after `const HISTORY_PAGE_SIZE = 25;` (line 13), add:

```typescript
// Ack-and-stream (#985): the reply arrives over SSE, not the POST. If no terminal
// event arrives within this window (rare: a suppressed-duplicate turn or an agent
// crash), the client fetches /history once to recover a missed reply, then shows a
// soft notice and unlocks the composer WITHOUT closing the stream — a late reply
// still renders. Deliberately long so legitimately slow tasks are never cut off.
const REPLY_WATCHDOG_MS = 5 * 60_000;
// How long to wait for the SSE connection to open before POSTing anyway. If the
// stream is degraded the POST still publishes and the watchdog recovers the reply.
const SSE_OPEN_TIMEOUT_MS = 3_000;
// Shown when the watchdog fires and /history has no reply yet.
const STILL_WORKING_TEXT =
  'Still working on this — it is taking longer than usual. The reply will appear here when it is ready.';
```

- [ ] **Step 3: Rewrite the `send` function**

Replace the entire `send` function (lines 189-281) with the ack+stream flow below. Key changes: open the stream and await `onopen` (bounded by `SSE_OPEN_TIMEOUT_MS`) before POSTing; treat the POST as an ack only; let the SSE terminal event finish the turn; arm a watchdog that recovers via `/history`.

```typescript
  async function send(text: string): Promise<void> {
    if (isSending.current || text.trim().length === 0) return;

    if (!conversationId.current) {
      const newId = crypto.randomUUID();
      conversationId.current = newId;
      // Guarded for restricted browsing contexts (e.g. Safari private mode).
      try { localStorage.setItem(CONV_ID_KEY, newId); } catch { /* best-effort */ }
    }
    const convId = conversationId.current;

    // Close any stream left open by a prior turn's soft-recovery path before
    // starting a new one, so we never leak a dangling EventSource.
    sourceRef.current?.close();
    sourceRef.current = null;

    const sentAt = Date.now();
    // Optimistic append so the user sees their message immediately.
    setMessages((prev) => [
      ...prev,
      makeMessage('user', text, { timestamp: new Date() }),
    ]);
    isSending.current = true;
    setSending(true);

    let source: EventSource | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    // Unlock the composer (and stop the watchdog) without touching the stream —
    // used by the soft-recovery path so a late reply can still render.
    const unlock = () => {
      if (watchdog) { clearTimeout(watchdog); watchdog = undefined; }
      isSending.current = false;
      setSending(false);
    };
    // Fully finish the turn: unlock and close the stream. Idempotent.
    const finalize = () => {
      if (settled) return;
      settled = true;
      unlock();
      source?.close();
      sourceRef.current = null;
    };

    // Watchdog recovery: fetch one history page and render a missed reply, else
    // post a soft notice and unlock (leaving the stream open for a late reply).
    const runRecovery = async () => {
      try {
        const res = await apiFetch(
          `/api/kg/chat/history?conversationId=${encodeURIComponent(convId)}&limit=${HISTORY_PAGE_SIZE}`,
        );
        if (res.ok) {
          const data = (await res.json()) as HistoryResponse;
          const recovered = pickRecoveredReply(data.messages, sentAt);
          if (recovered) {
            setMessages((prev) => [
              ...prev,
              makeMessage('agent', recovered.text, { html: recovered.html ?? undefined, timestamp: new Date() }),
            ]);
            finalize();
            return;
          }
        } else {
          console.error('[useChatSession] recovery history fetch non-ok:', res.status);
        }
      } catch (err) {
        console.error('[useChatSession] recovery history fetch failed:', err);
      }
      // Nothing to recover yet — soft notice, unlock, keep the stream open.
      setMessages((prev) => [...prev, makeMessage('status', STILL_WORKING_TEXT)]);
      unlock();
    };

    try {
      // Open the SSE stream and wait for it to connect BEFORE the POST, so a fast
      // reply broadcast can't race past an unregistered stream. withCredentials
      // sends the session cookie, matching apiFetch behavior.
      source = new EventSource(
        `/api/kg/chat/stream?conversationId=${encodeURIComponent(convId)}`,
        { withCredentials: true },
      );
      sourceRef.current = source;

      source.onmessage = (event: MessageEvent<string>) => {
        const parsed = parseSseEvent(event.data);
        if (!parsed) return;
        if (parsed.kind === 'status') {
          setMessages((prev) => [...prev, makeMessage('status', parsed.text)]);
          return;
        }
        if (parsed.kind === 'reply') {
          // Terminal: the agent's final reply for this turn.
          setMessages((prev) => [
            ...prev,
            makeMessage('agent', parsed.text, { html: parsed.html ?? undefined, timestamp: new Date() }),
          ]);
          finalize();
          return;
        }
        // parsed.kind === 'rejected' — terminal error.
        setMessages((prev) => [...prev, makeMessage('error', parsed.text)]);
        finalize();
      };

      source.onerror = (event) => {
        // Non-fatal: EventSource auto-reconnects on transient errors. On a fatal
        // close (readyState === CLOSED) the reply, if any, is recovered by the
        // watchdog via /history. We do not finalize here so a reconnect can still
        // deliver the terminal event.
        console.error('[useChatSession] SSE stream error (readyState=%d):', source?.readyState, event);
      };

      // Wait for the stream to open, but don't block forever — if it doesn't open
      // within SSE_OPEN_TIMEOUT_MS, POST anyway and let the watchdog recover.
      await new Promise<void>((resolve) => {
        if (!source) { resolve(); return; }
        if (source.readyState === EventSource.OPEN) { resolve(); return; }
        const to = setTimeout(resolve, SSE_OPEN_TIMEOUT_MS);
        source.onopen = () => { clearTimeout(to); resolve(); };
      });

      const res = await apiFetch('/api/kg/chat/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, conversationId: convId }),
      });

      if (!res.ok) {
        let errMsg = `Error ${res.status}`;
        try {
          const errData = await res.json() as { error?: string };
          if (errData.error) errMsg = errData.error;
        } catch (bodyErr) {
          // Non-JSON error body — log for debugging, fall back to HTTP status.
          console.error('[useChatSession] failed to parse error response body:', bodyErr);
        }
        setMessages((prev) => [...prev, makeMessage('error', errMsg)]);
        finalize();
        return;
      }

      // 202 ack received. The reply arrives over SSE; arm the watchdog in case it
      // never does (suppressed-duplicate turn or agent crash).
      watchdog = setTimeout(() => { void runRecovery(); }, REPLY_WATCHDOG_MS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Network error';
      setMessages((prev) => [...prev, makeMessage('error', msg)]);
      finalize();
    }
    // NOTE: no finally that clears sending/closes the stream — the turn is
    // finished by the SSE terminal event, the watchdog, or an error path above.
  }
```

Update the import on line 4 to include `pickRecoveredReply`:

```typescript
import { makeMessage, parseSseEvent, pickRecoveredReply } from './chat-utils.js';
```

- [ ] **Step 4: Typecheck the console app**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-chat-ack-stream/apps/console run typecheck`
Expected: no errors.

- [ ] **Step 5: Build the console app**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-chat-ack-stream/apps/console run build`
Expected: build succeeds (Vite emits to `dist/`).

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-chat-ack-stream add apps/console/src/pages/chat/useChatSession.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-chat-ack-stream commit -m "feat: web console chat renders reply from SSE stream, no sync wait (#985)"
```

---

## Task 5: Full verification + changelog

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add the changelog entry**

In `CHANGELOG.md`, under `## [Unreleased]` add a `### Changed` bullet (create the `### Changed` subsection if absent):

```markdown
- **Web console chat** — `POST /api/kg/chat/messages` now acks with `202` and the reply streams over SSE instead of blocking on a 120s synchronous wait, so long agent tasks (browser automation, delegation chains, research) complete without a 504. (#985)
```

- [ ] **Step 2: Run the full backend test suite**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-chat-ack-stream test`
Expected: PASS (all suites, including the rewritten event-router, kg-chat-routes, and chat-utils tests).

- [ ] **Step 3: Typecheck both packages**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-chat-ack-stream run typecheck`
Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-chat-ack-stream/apps/console run typecheck`
Expected: no errors in either.

- [ ] **Step 4: Lint**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-chat-ack-stream run lint`
Expected: no new errors.

- [ ] **Step 5: Manual verification (acceptance criteria)**

Per `superpowers:verification-before-completion`, run the app and exercise the chat:
1. Start the stack (or the console dev server against a running backend) and open the web console chat.
2. **Fast chat (<5s):** send a short message; confirm the reply appears promptly and the composer re-enables — still feels synchronous.
3. **Long task (>120s):** send a message that triggers a multi-step/delegation turn; confirm `invoking …` status lines appear during the wait and the final reply renders when ready, with **no 504 / no error**, past the old 120s cliff.
4. Confirm the Network tab shows the POST returning **202** immediately (not held open for minutes).
Record what you observed (the actual reply, timing) as evidence before claiming done.

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-chat-ack-stream add CHANGELOG.md
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-chat-ack-stream commit -m "docs: changelog for chat ack-and-stream (#985)"
```

---

## Post-implementation

- Run the pre-PR review subagents (code-reviewer, silent-failure-hunter) per global workflow.
- Open a PR with `Closes #985` in the Summary. CHANGELOG already updated.
- **Spotted-in-passing (do not fix here):** the `@TODO` at `event-router.ts:144-148` notes `sseClients` is shared across `/api/messages/stream` and `/api/kg/chat/stream` with no per-endpoint `channelId` filter. Out of scope for #985 — mention in the PR, don't touch.

## Self-review notes (author)

- **Spec coverage:** POST→202 (Task 2), SSE html (Task 1), frontend onopen-gate + terminal render + watchdog recovery (Tasks 3-4), tests (Tasks 1-3), changelog + manual AC check (Task 5). All four acceptance criteria map to Task 5 Step 5.
- **Type consistency:** `SseEvent` and `HistoryMessage` defined once in `types.ts`, consumed by `chat-utils.ts` and `useChatSession.ts`; `parseSseEvent` returns `SseEvent | null` everywhere; `pickRecoveredReply` signature matches its call site.
- **Known coverage gap (called out in Task 4):** hook timing/onopen/watchdog not unit-tested — no React harness in `apps/console`; logic extracted to tested pure helpers; follow-up issue suggested.
