# HTTP API Token Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the three remaining acceptance criteria for issue #189 — failed-auth logging, `trustLevel: 'medium'` on message metadata, and an integration test for the auth middleware.

**Architecture:** Auth enforcement already lives in the `onRequest` hook in `HttpAdapter`. The two production changes are surgical additions to existing files: one `logger.warn` call in the hook, and one metadata field in the route handler. The integration test needs a Fastify app that includes the auth hook (the existing test suite skips it).

**Tech Stack:** TypeScript/ESM, Fastify, Vitest, pino

**Worktree:** `/Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-http-auth-token`

---

## File Map

| File | Change |
|---|---|
| `src/channels/http/http-adapter.ts` | Add `logger.warn` in auth hook when token is missing or invalid |
| `src/channels/http/routes/messages.ts` | Add `metadata: { trustLevel: 'medium' }` to `createInboundMessage` call |
| `tests/integration/http-api.test.ts` | Add new `describe` block testing auth middleware end-to-end |

---

## Task 1: Log failed auth attempts

**Files:**
- Modify: `src/channels/http/http-adapter.ts:125-127`

The auth hook currently returns 401 silently. We need a `logger.warn` before the reply so failed attempts are structured-logged with source IP and failure reason. The `logger` variable is already in scope (captured at the top of `start()`).

- [ ] **Step 1: Add the warn log in the auth hook**

Open `src/channels/http/http-adapter.ts`. Find the auth check at line 125:

```typescript
      if (!validateBearerToken(request.headers.authorization, apiToken)) {
        return reply.status(401).send({ error: 'Unauthorized — provide a valid Bearer token' });
      }
```

Replace it with:

```typescript
      if (!validateBearerToken(request.headers.authorization, apiToken)) {
        // Audit-log the failure: IP, route, and whether a token was even provided.
        // Never log the token value — only that it was present and wrong vs absent.
        const reason = request.headers.authorization ? 'invalid_token' : 'missing_token';
        logger.warn({ ip: request.ip, route: routeUrl, reason }, 'HTTP auth failed');
        return reply.status(401).send({ error: 'Unauthorized — provide a valid Bearer token' });
      }
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-http-auth-token run build 2>&1 | tail -10
```

Expected: exits 0, no type errors.

- [ ] **Step 3: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-http-auth-token add src/channels/http/http-adapter.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-http-auth-token commit -m "feat: log failed HTTP auth attempts (issue #189)"
```

---

## Task 2: Tag authenticated messages with `trustLevel: 'medium'`

**Files:**
- Modify: `src/channels/http/routes/messages.ts:56-61`

The HTTP channel's structural trust level is `medium` (token auth, low spoofing risk). Downstream consumers (dispatch, agents) use this to compute trust scores. The `metadata` field on `InboundMessagePayload` is `Record<string, unknown>` — no type changes needed.

- [ ] **Step 1: Add `metadata` to the `createInboundMessage` call**

Open `src/channels/http/routes/messages.ts`. Find the `createInboundMessage` call at line 56:

```typescript
    const inboundEvent = createInboundMessage({
      conversationId,
      channelId: 'http',
      senderId,
      content: body.content,
    });
```

Replace it with:

```typescript
    const inboundEvent = createInboundMessage({
      conversationId,
      channelId: 'http',
      senderId,
      content: body.content,
      // Tag with structural channel trust level. Future work will compute
      // messageTrustScore from trustLevel + contactConfidence + content risk.
      metadata: { trustLevel: 'medium' },
    });
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-http-auth-token run build 2>&1 | tail -10
```

Expected: exits 0, no type errors.

- [ ] **Step 3: Run the existing integration tests to confirm nothing broke**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-http-auth-token run test -- tests/integration/http-api.test.ts 2>&1 | tail -15
```

Expected: 5 tests pass.

- [ ] **Step 4: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-http-auth-token add src/channels/http/routes/messages.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-http-auth-token commit -m "feat: tag HTTP messages with trustLevel medium (issue #189)"
```

---

## Task 3: Integration test for auth middleware

**Files:**
- Modify: `tests/integration/http-api.test.ts` (add new `describe` block at the end)

The existing test suites build raw Fastify apps with just routes — no auth hook. This new suite builds a minimal Fastify app with the same `onRequest` hook logic as `HttpAdapter` to test it end-to-end without needing to spin up the full adapter.

Strategy: replicate the auth hook in the test's Fastify app, identical to what `HttpAdapter.start()` does, so we test the actual hook logic rather than a mock.

- [ ] **Step 1: Write the failing test suite**

Append the following `describe` block to `tests/integration/http-api.test.ts`:

```typescript
// Issue #189: HTTP API channel must require token-based authentication.
// This suite exercises the auth middleware (onRequest hook) end-to-end.
// It builds a minimal Fastify app with the same hook as HttpAdapter
// to test auth independently from the message flow.
describe('HTTP API — bearer token authentication', () => {
  const TEST_TOKEN = 'test-secret-token-abc123';

  // Build a minimal Fastify app with the same onRequest hook as HttpAdapter.
  // We test auth in isolation here — message routing is covered by other suites.
  async function buildApp(token: string | undefined) {
    const app = Fastify();
    const bus = new EventBus(logger);
    const eventRouter = new EventRouter(logger);
    const mockPool = {
      query: async () => ({ rows: [{ '?column?': 1 }] }),
    } as unknown as Pool;

    eventRouter.setupSubscriptions(bus);

    // Register a minimal agent so POST /api/messages can return a response.
    const mockProvider: LLMProvider = {
      id: 'mock',
      chat: async () => ({
        type: 'text' as const,
        content: 'auth test response',
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    };
    const coordinator = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are a test agent.',
      provider: mockProvider,
      bus,
      logger,
    });
    coordinator.register();
    const dispatcher = new Dispatcher({ bus, logger });
    dispatcher.register();

    // Auth hook — same logic as HttpAdapter.start()
    app.addHook('onRequest', async (request, reply) => {
      const routeUrl = request.routeOptions.url ?? '';
      if (routeUrl === '/api/health') return;
      if (!validateBearerToken(request.headers.authorization, token)) {
        const reason = request.headers.authorization ? 'invalid_token' : 'missing_token';
        logger.warn({ ip: request.ip, route: routeUrl, reason }, 'HTTP auth failed');
        return reply.status(401).send({ error: 'Unauthorized — provide a valid Bearer token' });
      }
    });

    app.register(messageRoutes, { bus, logger, eventRouter });
    app.register(healthRoutes, { pool: mockPool, logger, agentNames: ['coordinator'], skillNames: [] });

    await app.ready();
    return app;
  }

  it('rejects POST /api/messages with no Authorization header (401)', async () => {
    const app = await buildApp(TEST_TOKEN);
    const response = await app.inject({
      method: 'POST',
      url: '/api/messages',
      payload: { content: 'hello' },
      // No headers — no Authorization
    });
    await app.close();
    expect(response.statusCode).toBe(401);
    const body = JSON.parse(response.body);
    expect(body.error).toContain('Unauthorized');
  });

  it('rejects POST /api/messages with a wrong token (401)', async () => {
    const app = await buildApp(TEST_TOKEN);
    const response = await app.inject({
      method: 'POST',
      url: '/api/messages',
      payload: { content: 'hello' },
      headers: { authorization: 'Bearer wrong-token' },
    });
    await app.close();
    expect(response.statusCode).toBe(401);
    const body = JSON.parse(response.body);
    expect(body.error).toContain('Unauthorized');
  });

  it('accepts POST /api/messages with a valid token (200)', async () => {
    const app = await buildApp(TEST_TOKEN);
    const response = await app.inject({
      method: 'POST',
      url: '/api/messages',
      payload: { content: 'hello', conversation_id: 'auth-test-conv-1' },
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    await app.close();
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.conversation_id).toBe('auth-test-conv-1');
  });

  it('allows GET /api/health with no token (health is auth-exempt)', async () => {
    const app = await buildApp(TEST_TOKEN);
    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      // No Authorization header
    });
    await app.close();
    expect(response.statusCode).toBe(200);
  });

  it('accepts POST /api/messages when no token is configured (auth disabled)', async () => {
    const app = await buildApp(undefined); // auth disabled
    const response = await app.inject({
      method: 'POST',
      url: '/api/messages',
      payload: { content: 'hello', conversation_id: 'auth-disabled-conv-1' },
      // No Authorization header
    });
    await app.close();
    expect(response.statusCode).toBe(200);
  });
});
```

You also need to add `validateBearerToken` to the imports at the top of the test file. The existing import block starts at line 1 — add one line:

```typescript
import { validateBearerToken } from '../../src/channels/http/auth.js';
```

- [ ] **Step 2: Run the new tests to verify they fail (not yet — they should pass since impl is done)**

Actually: since Tasks 1 and 2 are already committed before this task, the tests should pass on first run. Run them to confirm:

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-http-auth-token run test -- tests/integration/http-api.test.ts 2>&1 | tail -20
```

Expected: all 10 tests pass (5 existing + 5 new).

- [ ] **Step 3: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-http-auth-token add tests/integration/http-api.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-http-auth-token commit -m "test: integration tests for HTTP bearer token auth (issue #189)"
```

---

## Task 4: Update CHANGELOG and version

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `package.json`

This is completing a partially-shipped spec (HTTP auth was stubbed, now it's complete) — patch bump per versioning policy.

- [ ] **Step 1: Check current version**

```bash
grep '"version"' /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-http-auth-token/package.json
```

- [ ] **Step 2: Update CHANGELOG.md**

Open `CHANGELOG.md`. Under `## [Unreleased]`, add to the `Security` section (create it if absent):

```markdown
### Security

- **HTTP API token authentication** — failed auth attempts are now audit-logged (IP, route, reason); authenticated messages carry `trustLevel: 'medium'` in bus event metadata; integration tests verify 401 on missing/invalid token and 200 on valid token (spec 06, issue #189)
```

- [ ] **Step 3: Bump patch version in package.json**

If current version is `0.14.4`, change to `0.14.5`. Edit `package.json`:

```json
"version": "0.14.5",
```

- [ ] **Step 4: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-http-auth-token add CHANGELOG.md package.json
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-http-auth-token commit -m "chore: bump to 0.14.5, changelog for HTTP auth (issue #189)"
```

---

## Task 5: Full test run before PR

- [ ] **Step 1: Run the full test suite**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-http-auth-token run test 2>&1 | tail -20
```

Expected: all tests pass, no failures.

- [ ] **Step 2: Confirm build is clean**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-http-auth-token run build 2>&1 | tail -10
```

Expected: exits 0.
