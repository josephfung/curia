# Onboarding Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a multi-step onboarding wizard to the Curia web app that captures office identity config on first run and is accessible via Settings → Setup Wizard for re-entry.

**Architecture:** Full-screen overlay inside the existing `createUiHtml()` HTML template in `kg.ts`. Backend changes: (1) extract the session auth helper to a shared module so both KG and identity routes accept session cookies; (2) add a `configured` boolean to `GET /api/identity` to drive first-run detection without client-side state.

**Tech Stack:** Fastify, vanilla JS, CSS custom properties (already in use), Vitest for unit tests.

---

## File Map

| File | Action | What changes |
|------|--------|--------------|
| `src/channels/http/session-auth.ts` | **Create** | `SessionStore` type + `assertSecret()` function extracted from kg.ts |
| `src/channels/http/http-adapter.ts` | **Modify** | Create sessions Map here; pass to both KG and identity routes |
| `src/channels/http/routes/kg.ts` | **Modify** | Import `assertSecret` from session-auth; accept sessions via options; add Settings nav, wizard overlay, wizard JS, update `showMain()` and `navigate()` |
| `src/channels/http/routes/identity.ts` | **Modify** | Accept sessions + pool in options; use `assertSecret` for cookie+header auth; add `configured` flag to `GET /api/identity` |
| `tests/unit/channels/http/identity-routes.test.ts` | **Create** | Unit tests for updated identity route auth and `configured` flag |
| `tests/unit/channels/http/session-auth.test.ts` | **Create** | Unit tests for extracted `assertSecret` helper |
| `CHANGELOG.md` | **Modify** | Add unreleased entry |
| `package.json` | **Modify** | Minor version bump |

---

## Task 1: Extract session auth to shared module

The `assertSecret()` function and `SessionStore` type currently live inside `knowledgeGraphRoutes` in `kg.ts`. Identity routes need the same logic. Extract them into `src/channels/http/session-auth.ts` so both route files can share them.

**Files:**
- Create: `src/channels/http/session-auth.ts`
- Create: `tests/unit/channels/http/session-auth.test.ts`

- [ ] **Step 1.1: Write the failing test**

Create `tests/unit/channels/http/session-auth.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { assertSecret, type SessionStore } from '../../../../src/channels/http/session-auth.js';

// Helper: build a minimal FastifyRequest with optional session cookie and optional secret header.
function makeRequest(opts: {
  secretHeader?: string;
  sessionToken?: string;
}): FastifyRequest {
  return {
    headers: opts.secretHeader ? { 'x-web-bootstrap-secret': opts.secretHeader } : {},
    cookies: opts.sessionToken ? { curia_session: opts.sessionToken } : undefined,
  } as unknown as FastifyRequest;
}

function makeReply(): FastifyReply & { statusCode: number; body: unknown } {
  const reply = { statusCode: 0, body: undefined as unknown };
  (reply as unknown as FastifyReply).status = (n: number) => ({
    send: (b: unknown) => { reply.statusCode = n; reply.body = b; },
  }) as unknown as FastifyReply;
  return reply as unknown as FastifyReply & { statusCode: number; body: unknown };
}

describe('assertSecret', () => {
  const configuredSecret = 'correct-secret';
  let sessions: SessionStore;

  beforeEach(() => {
    sessions = new Map();
  });

  it('accepts a valid x-web-bootstrap-secret header', () => {
    const request = makeRequest({ secretHeader: 'correct-secret' });
    const reply = makeReply();
    expect(assertSecret(request, reply as unknown as FastifyReply, configuredSecret, sessions)).toBe(true);
  });

  it('rejects an invalid x-web-bootstrap-secret header', () => {
    const request = makeRequest({ secretHeader: 'wrong-secret' });
    const reply = makeReply();
    expect(assertSecret(request, reply as unknown as FastifyReply, configuredSecret, sessions)).toBe(false);
    expect(reply.statusCode).toBe(401);
  });

  it('accepts a valid session cookie', () => {
    const token = 'valid-token-abc';
    sessions.set(token, Date.now() + 60_000);
    const request = makeRequest({ sessionToken: token });
    const reply = makeReply();
    expect(assertSecret(request, reply as unknown as FastifyReply, configuredSecret, sessions)).toBe(true);
  });

  it('rejects an expired session cookie', () => {
    const token = 'expired-token';
    sessions.set(token, Date.now() - 1000);
    const request = makeRequest({ sessionToken: token });
    const reply = makeReply();
    expect(assertSecret(request, reply as unknown as FastifyReply, configuredSecret, sessions)).toBe(false);
    expect(reply.statusCode).toBe(401);
  });

  it('rejects an unknown session cookie', () => {
    const request = makeRequest({ sessionToken: 'unknown-token' });
    const reply = makeReply();
    expect(assertSecret(request, reply as unknown as FastifyReply, configuredSecret, sessions)).toBe(false);
    expect(reply.statusCode).toBe(401);
  });

  it('returns 503 when no configured secret is provided', () => {
    const request = makeRequest({ secretHeader: 'anything' });
    const reply = makeReply();
    expect(assertSecret(request, reply as unknown as FastifyReply, undefined, sessions)).toBe(false);
    expect(reply.statusCode).toBe(503);
  });
});
```

- [ ] **Step 1.2: Run the test to confirm it fails**

```bash
cd /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-onboarding-wizard
pnpm test -- tests/unit/channels/http/session-auth.test.ts
```

Expected: fails with `Cannot find module '../../../../src/channels/http/session-auth.js'`

- [ ] **Step 1.3: Create `src/channels/http/session-auth.ts`**

```typescript
// session-auth.ts — Shared session authentication helper for HTTP routes.
//
// Both the KG routes and the identity routes accept authentication via either:
//   1. A valid `curia_session` HttpOnly cookie (set by POST /auth)
//   2. A valid `x-web-bootstrap-secret` request header (for programmatic access)
//
// The sessions Map is created in HttpAdapter and passed to both route registrations.

import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';

// token → expiry timestamp in ms. Lives in HttpAdapter, shared across route registrations.
export type SessionStore = Map<string, number>;

/**
 * Verify that the request is authenticated via session cookie or bootstrap secret header.
 *
 * Returns true if authenticated. Returns false and sends an error response if not.
 *
 * Why timingSafeEqual: prevents character-by-character brute force against the secret.
 * We compare byte lengths before calling it because timingSafeEqual throws if buffers
 * differ in length.
 */
export function assertSecret(
  request: FastifyRequest,
  reply: FastifyReply,
  configuredSecret: string | undefined,
  sessions: SessionStore,
): boolean {
  if (!configuredSecret) {
    reply.status(503).send({
      error: 'Web UI is disabled. Set WEB_APP_BOOTSTRAP_SECRET in .env to enable it.',
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

  // Fallback: direct header (programmatic access via curl / scripts).
  // Reject non-string values (Fastify coerces duplicate headers to string[]).
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
```

- [ ] **Step 1.4: Run the test to confirm it passes**

```bash
pnpm test -- tests/unit/channels/http/session-auth.test.ts
```

Expected: all 6 tests pass.

- [ ] **Step 1.5: Update `kg.ts` to import from `session-auth.ts`**

In `src/channels/http/routes/kg.ts`:

Add the import after the existing imports at the top of the file:
```typescript
import { assertSecret, type SessionStore } from '../session-auth.js';
```

Remove the local `type SessionStore = Map<string, number>;` declaration (around line 44).

Remove the local `function assertSecret(...)` declaration (lines ~77–116). The function is now imported.

All existing `assertSecret(request, reply, webAppBootstrapSecret, sessions)` call sites remain unchanged — the signature is identical.

- [ ] **Step 1.6: Run the full test suite to confirm nothing broke**

```bash
pnpm test
```

Expected: all tests pass.

- [ ] **Step 1.7: Commit**

```bash
git add src/channels/http/session-auth.ts tests/unit/channels/http/session-auth.test.ts src/channels/http/routes/kg.ts
git commit -m "refactor: extract session auth helper to shared module"
```

---

## Task 2: Lift sessions store to HttpAdapter

The `sessions` Map is currently created inside `knowledgeGraphRoutes`. It needs to be accessible to `identityRoutes` too. Move its creation to `HttpAdapter` and pass it in via route options.

**Files:**
- Modify: `src/channels/http/http-adapter.ts`
- Modify: `src/channels/http/routes/kg.ts`
- Modify: `src/channels/http/routes/identity.ts`

- [ ] **Step 2.1: Add `sessions` to `KnowledgeGraphRouteOptions` in `kg.ts`**

Update the `KnowledgeGraphRouteOptions` interface:

```typescript
export interface KnowledgeGraphRouteOptions {
  pool: Pool;
  logger: Logger;
  webAppBootstrapSecret: string | undefined;
  secureCookies: boolean;
  bus: EventBus;
  eventRouter: EventRouter;
  contactService: ContactService;
  // Shared session store — created in HttpAdapter, passed to both KG and identity routes
  // so both can accept the curia_session cookie for authentication.
  sessions: SessionStore;
}
```

- [ ] **Step 2.2: Remove sessions Map creation from `knowledgeGraphRoutes`**

Inside `knowledgeGraphRoutes` (around line 2140), remove:

```typescript
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
```

Destructure `sessions` from options at the top of `knowledgeGraphRoutes`:

```typescript
export async function knowledgeGraphRoutes(
  app: FastifyInstance,
  options: KnowledgeGraphRouteOptions,
): Promise<void> {
  const { pool, logger, webAppBootstrapSecret, secureCookies, bus, eventRouter, contactService, sessions } = options;
  // sessions is managed by HttpAdapter — no local Map creation needed here.
```

- [ ] **Step 2.3: Update `IdentityRouteOptions` in `identity.ts` to accept sessions and pool**

```typescript
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { OfficeIdentityService } from '../../../identity/service.js';
import type { OfficeIdentity } from '../../../identity/types.js';
import { assertSecret, type SessionStore } from '../session-auth.js';

export interface IdentityRouteOptions {
  identityService: OfficeIdentityService;
  webAppBootstrapSecret: string;
  // Shared session store from HttpAdapter — allows browser sessions (cookie auth)
  // to call identity routes without the raw bootstrap secret being stored in JS.
  sessions: SessionStore;
  // Required for the configured flag query on GET /api/identity.
  pool: Pool;
}
```

Replace the local `validateBootstrapSecret` function and `requireBootstrapSecret` helper entirely. The new `identityRoutes` function body opens with:

```typescript
export async function identityRoutes(
  app: FastifyInstance,
  options: IdentityRouteOptions,
): Promise<void> {
  const { identityService, webAppBootstrapSecret, sessions, pool } = options;

  // Auth helper — validates session cookie or bootstrap secret on every request.
  function requireAuth(request: FastifyRequest, reply: FastifyReply): boolean {
    return assertSecret(request, reply, webAppBootstrapSecret, sessions);
  }
```

Update all four route handlers to call `requireAuth(request, reply)`:
- `GET /api/identity` → `if (!requireAuth(request, reply)) return;`
- `PUT /api/identity` → `if (!requireAuth(request, reply)) return;`
- `GET /api/identity/history` → `if (!requireAuth(request, reply)) return;`
- `POST /api/identity/reload` → `if (!requireAuth(request, reply)) return;`

- [ ] **Step 2.4: Update `GET /api/identity` to include the `configured` flag**

Replace the `GET /api/identity` handler body:

```typescript
  app.get('/api/identity', async (request, reply) => {
    if (!requireAuth(request, reply)) return;

    try {
      const identity = identityService.get();

      // Determine whether the identity has ever been explicitly configured via the wizard
      // or API. A fresh deployment (only file_load versions) returns configured: false,
      // which triggers the first-run wizard in the browser.
      const configuredResult = await pool.query<{ configured: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM office_identity_versions
           WHERE changed_by IN ('wizard', 'api')
         ) AS configured`,
      );
      const configured = configuredResult.rows[0]?.configured ?? false;

      return reply.send({ identity, configured });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to get identity';
      return reply.status(500).send({ error: message });
    }
  });
```

- [ ] **Step 2.5: Update `HttpAdapter` to create sessions + pass to both routes**

Add the import at the top of `src/channels/http/http-adapter.ts`:
```typescript
import { type SessionStore } from './session-auth.js';
```

In the `start()` method, after registering cors and rateLimit but before registering routes, add:

```typescript
    // Shared session store — used by both KG and identity routes to validate browser sessions.
    // Sessions are set by POST /auth (KG routes) and verified by both route registrations.
    const sessions: SessionStore = new Map();
    const pruneInterval = setInterval(() => {
      const now = Date.now();
      for (const [token, expiresAt] of sessions) {
        if (now > expiresAt) sessions.delete(token);
      }
    }, 60_000);
    pruneInterval.unref();
```

Update the identity routes registration:
```typescript
    if (webAppBootstrapSecret && this.config.identityService) {
      await this.app.register(identityRoutes, {
        identityService: this.config.identityService,
        webAppBootstrapSecret,
        sessions,
        pool,
      });
    }
```

Update the KG routes registration:
```typescript
    if (webAppBootstrapSecret) {
      const secureCookies = appOrigin?.startsWith('https://') ?? false;
      await this.app.register(knowledgeGraphRoutes, {
        pool,
        logger,
        webAppBootstrapSecret,
        secureCookies,
        bus,
        eventRouter: this.eventRouter,
        contactService: this.config.contactService,
        sessions,
      });
    }
```

- [ ] **Step 2.6: Update existing kg-routes unit tests to pass sessions**

In `tests/unit/channels/http/kg-routes.test.ts`, add `sessions: new Map()` to every `knowledgeGraphRoutes` registration:

```typescript
await app.register(knowledgeGraphRoutes, {
  pool,
  logger: createLogger(),
  webAppBootstrapSecret: 'secret-1',
  secureCookies: false,
  sessions: new Map(),
});
```

Apply to all registrations in the file.

- [ ] **Step 2.7: Run the full test suite**

```bash
pnpm test
```

Expected: all tests pass.

- [ ] **Step 2.8: Commit**

```bash
git add src/channels/http/session-auth.ts src/channels/http/http-adapter.ts src/channels/http/routes/kg.ts src/channels/http/routes/identity.ts tests/unit/channels/http/kg-routes.test.ts
git commit -m "refactor: lift sessions store to HttpAdapter; identity routes now accept session cookie and configured flag"
```

---

## Task 3: Identity routes unit tests

Write unit tests for the updated identity route behaviours: session cookie auth and the `configured` flag.

**Files:**
- Create: `tests/unit/channels/http/identity-routes.test.ts`

- [ ] **Step 3.1: Write the tests**

Create `tests/unit/channels/http/identity-routes.test.ts`:

```typescript
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import type { Pool } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { identityRoutes } from '../../../../src/channels/http/routes/identity.js';
import type { OfficeIdentityService } from '../../../../src/identity/service.js';
import type { OfficeIdentity } from '../../../../src/identity/types.js';

const MOCK_IDENTITY: OfficeIdentity = {
  assistant: { name: 'Alex Curia', title: 'Executive Assistant', emailSignature: 'Alex Curia\nOffice of the CEO' },
  tone: { baseline: ['warm', 'direct'], verbosity: 50, directness: 75 },
  behavioralPreferences: ['Be concise'],
  decisionStyle: { externalActions: 'conservative', internalAnalysis: 'proactive' },
  constraints: ['Never impersonate the CEO'],
};

function createMockIdentityService(): OfficeIdentityService {
  return {
    get: vi.fn().mockReturnValue(MOCK_IDENTITY),
    update: vi.fn().mockResolvedValue(undefined),
    reload: vi.fn().mockResolvedValue(undefined),
    history: vi.fn().mockResolvedValue([]),
    compileSystemPromptBlock: vi.fn().mockReturnValue(''),
    initialize: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  } as unknown as OfficeIdentityService;
}

const SECRET = 'test-bootstrap-secret';

describe('GET /api/identity — configured flag', () => {
  const sessions = new Map<string, number>();

  beforeEach(() => sessions.clear());

  it('returns configured: false when only file_load versions exist', async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [{ configured: false }] }),
    } as unknown as Pool;

    const app = Fastify();
    await app.register(cookie);
    await app.register(identityRoutes, {
      identityService: createMockIdentityService(),
      webAppBootstrapSecret: SECRET,
      sessions,
      pool,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/identity',
      headers: { 'x-web-bootstrap-secret': SECRET },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.configured).toBe(false);
    expect(body.identity.assistant.name).toBe('Alex Curia');

    await app.close();
  });

  it('returns configured: true when a wizard version exists', async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [{ configured: true }] }),
    } as unknown as Pool;

    const app = Fastify();
    await app.register(cookie);
    await app.register(identityRoutes, {
      identityService: createMockIdentityService(),
      webAppBootstrapSecret: SECRET,
      sessions,
      pool,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/identity',
      headers: { 'x-web-bootstrap-secret': SECRET },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().configured).toBe(true);

    await app.close();
  });

  it('accepts a valid session cookie in place of the header', async () => {
    const token = 'valid-session-token';
    sessions.set(token, Date.now() + 60_000);

    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [{ configured: true }] }),
    } as unknown as Pool;

    const app = Fastify();
    await app.register(cookie);
    await app.register(identityRoutes, {
      identityService: createMockIdentityService(),
      webAppBootstrapSecret: SECRET,
      sessions,
      pool,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/identity',
      headers: { cookie: `curia_session=${token}` },
    });

    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('rejects requests with no auth', async () => {
    const pool = { query: vi.fn() } as unknown as Pool;

    const app = Fastify();
    await app.register(cookie);
    await app.register(identityRoutes, {
      identityService: createMockIdentityService(),
      webAppBootstrapSecret: SECRET,
      sessions,
      pool,
    });

    const res = await app.inject({ method: 'GET', url: '/api/identity' });

    expect(res.statusCode).toBe(401);

    await app.close();
  });
});

describe('PUT /api/identity — session cookie auth', () => {
  const sessions = new Map<string, number>();

  beforeEach(() => sessions.clear());

  it('accepts PUT with a valid session cookie', async () => {
    const token = 'put-session-token';
    sessions.set(token, Date.now() + 60_000);

    const pool = { query: vi.fn() } as unknown as Pool;
    const identityService = createMockIdentityService();

    const app = Fastify();
    await app.register(cookie);
    await app.register(identityRoutes, {
      identityService,
      webAppBootstrapSecret: SECRET,
      sessions,
      pool,
    });

    const res = await app.inject({
      method: 'PUT',
      url: '/api/identity',
      headers: { cookie: `curia_session=${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ identity: MOCK_IDENTITY }),
    });

    expect(res.statusCode).toBe(200);
    expect(identityService.update).toHaveBeenCalledWith(MOCK_IDENTITY, 'api', undefined);

    await app.close();
  });
});
```

- [ ] **Step 3.2: Run the tests**

```bash
pnpm test -- tests/unit/channels/http/identity-routes.test.ts
```

Expected: all 5 tests pass.

- [ ] **Step 3.3: Run the full test suite**

```bash
pnpm test
```

Expected: all tests pass.

- [ ] **Step 3.4: Commit**

```bash
git add tests/unit/channels/http/identity-routes.test.ts
git commit -m "test: add identity route unit tests for configured flag and session cookie auth"
```

---

## Task 4: Settings nav + navigate('wizard') + default landing → Chat

Add the Settings nav section and update JS to handle the wizard view and the new default landing screen.

**Files:**
- Modify: `src/channels/http/routes/kg.ts`

- [ ] **Step 4.1: Add Settings nav HTML to the sidebar**

In `createUiHtml()`, find the line that closes the nav tree div (the `</div>` just before `</nav>`):

```html
      </div>
    </nav>
```

Add the Settings section immediately before that closing `</div>`:

```html
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
```

- [ ] **Step 4.2: Add Settings JS state, DOM refs, and `toggleSettings()`**

In the JS block, after `var memoryOpen = true;`, add:
```javascript
    var settingsOpen = true; // Settings nav section expanded by default
```

After the `memorySubmenu` and `memoryCaret` DOM ref assignments, add:
```javascript
    var settingsSubmenu = document.getElementById('settings-submenu');
    var settingsCaret   = document.getElementById('settings-chevron');
```

Add `!settingsSubmenu || !settingsCaret ||` to the null-check guard.

After `toggleMemory()`, add:
```javascript
    function toggleSettings() {
      settingsOpen = !settingsOpen;
      settingsSubmenu.style.display = settingsOpen ? 'flex' : 'none';
      settingsCaret.classList.toggle('collapsed', !settingsOpen);
    }
```

- [ ] **Step 4.3: Update `navigate()` to handle `'wizard'`**

Find `navigate()`. Add `viewWizard` to the local vars and display switching, and add the wizard fetch-and-show block:

```javascript
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
        fetch('/api/identity')
          .then(function(res) { return res.json(); })
          .then(function(data) { showWizard(data.identity); })
          .catch(function() {
            showWizard({
              assistant: { name: '', title: '', emailSignature: '' },
              tone: { baseline: ['warm', 'direct'], verbosity: 50, directness: 75 },
              decisionStyle: { externalActions: 'conservative' },
            });
          });
        return;
      }

      kgView.style.display            = view === 'kg'             ? 'flex' : 'none';
      chatView.style.display          = view === 'chat'           ? 'flex' : 'none';
      contactsView.style.display      = view === 'contacts'       ? 'flex' : 'none';
      tasksView.style.display         = view === 'tasks'          ? 'flex' : 'none';
      scheduledJobsView.style.display = view === 'scheduled-jobs' ? 'flex' : 'none';
      if (viewWizard) viewWizard.style.display = 'none'; // always hide when navigating elsewhere
```

(Keep the rest of `navigate()` — KG resize, contacts/tasks/jobs load, chat init, nav highlight — unchanged.)

- [ ] **Step 4.4: Change default landing from KG to Chat in `showMain()`**

Find `showMain()`:

```javascript
    function showMain() {
      authWall.style.display = 'none';
      mainApp.style.display  = 'flex';
      initCytoscape();
      search(); // auto-load all nodes on entry
    }
```

Replace with:

```javascript
    function showMain() {
      authWall.style.display = 'none';
      // Check whether identity has been configured via the wizard. If not, show the
      // wizard overlay. Main app stays hidden until wizard completes (or identity check fails).
      fetch('/api/identity')
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (!data.configured) {
            showWizard(data.identity);
          } else {
            mainApp.style.display = 'flex';
            navigate('chat', 'Chat', 'nav-chat');
            initCytoscape();
          }
        })
        .catch(function() {
          // Identity service not available or check failed — fall back to main app.
          mainApp.style.display = 'flex';
          navigate('chat', 'Chat', 'nav-chat');
          initCytoscape();
        });
    }
```

- [ ] **Step 4.5: Run the full test suite**

```bash
pnpm test
```

Expected: all tests pass.

- [ ] **Step 4.6: Commit**

```bash
git add src/channels/http/routes/kg.ts
git commit -m "feat: Settings nav, wizard navigate case, Chat as default landing"
```

---

## Task 5: Wizard overlay HTML + CSS

Add the full wizard overlay structure (all 4 steps) and all required CSS.

**Files:**
- Modify: `src/channels/http/routes/kg.ts`

- [ ] **Step 5.1: Add wizard CSS**

In `createUiHtml()`, find the closing `</style>` tag and add the following immediately before it:

```css
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
```

- [ ] **Step 5.2: Add wizard overlay HTML**

In `createUiHtml()`, find the closing `</main>` tag. Add the wizard overlay immediately before it:

```html
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
```

- [ ] **Step 5.3: Add success banner to the chat thread**

In `createUiHtml()`, find the `.chat-thread` div inside `#view-chat`. At the very top of `.chat-thread` (before `.chat-messages`), add:

```html
            <!-- Success banner — shown briefly after wizard completes -->
            <div id="chat-success-banner">Your assistant is ready.</div>
```

- [ ] **Step 5.4: Run the full test suite**

```bash
pnpm test
```

Expected: all tests pass.

- [ ] **Step 5.5: Commit**

```bash
git add src/channels/http/routes/kg.ts
git commit -m "feat: wizard overlay HTML and CSS"
```

---

## Task 6: Wizard JS — state, step navigation, validation

Wire up the wizard's state object, step navigator, and validation.

**Files:**
- Modify: `src/channels/http/routes/kg.ts`

- [ ] **Step 6.1: Add `wizardState`, `TONE_OPTIONS`, and DOM refs**

In the JS block, after `var settingsOpen = true;`, add:

```javascript
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
```

After the existing DOM ref assignments, add:

```javascript
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
```

Add all new refs to the null-check guard.

- [ ] **Step 6.2: Add `navigateWizardStep()`, `showWizard()`, `hideWizard()`**

After `toggleSettings()`, add:

```javascript
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
      wizardState.name      = (identity.assistant && identity.assistant.name)      || '';
      wizardState.title     = (identity.assistant && identity.assistant.title)     || '';
      wizardState.signature = (identity.assistant && identity.assistant.emailSignature) || '';
      wizardState.toneBaseline = (identity.tone && identity.tone.baseline && identity.tone.baseline.length)
        ? identity.tone.baseline.slice() : ['warm', 'direct'];
      wizardState.verbosity  = (identity.tone && identity.tone.verbosity  != null) ? identity.tone.verbosity  : 50;
      wizardState.directness = (identity.tone && identity.tone.directness != null) ? identity.tone.directness : 75;
      wizardState.posture    = (identity.decisionStyle && identity.decisionStyle.externalActions)
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
```

- [ ] **Step 6.3: Add `validateWizardStep()`, `wizardNext()`, `wizardBack()`**

```javascript
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
```

- [ ] **Step 6.4: Run the full test suite**

```bash
pnpm test
```

Expected: all tests pass.

- [ ] **Step 6.5: Commit**

```bash
git add src/channels/http/routes/kg.ts
git commit -m "feat: wizard JS — state, step navigation, validation"
```

---

## Task 7: Wizard JS — tone pills, sliders, posture picker

Wire up Step 2's interactive elements.

**Files:**
- Modify: `src/channels/http/routes/kg.ts`

- [ ] **Step 7.1: Add tone pill functions**

After `wizardBack()`, add:

```javascript
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
```

- [ ] **Step 7.2: Add slider preview functions**

```javascript
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
```

- [ ] **Step 7.3: Add posture picker functions**

```javascript
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
```

- [ ] **Step 7.4: Run the full test suite**

```bash
pnpm test
```

Expected: all tests pass.

- [ ] **Step 7.5: Commit**

```bash
git add src/channels/http/routes/kg.ts
git commit -m "feat: wizard JS — tone pills, sliders, posture picker"
```

---

## Task 8: Wizard JS — review step, submit flow, success banner

Implement the Review step renderer and submit function.

**Files:**
- Modify: `src/channels/http/routes/kg.ts`

- [ ] **Step 8.1: Add `renderReview()` using safe DOM construction**

The review card is built entirely with `textContent` and DOM methods — no `innerHTML` — to eliminate XSS risk from user-supplied wizard inputs.

```javascript
    // ── Review & submit ────────────────────────────────────────────────

    function renderReview() {
      var card = document.getElementById('review-card');
      // Remove all existing child nodes safely (no innerHTML).
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
```

- [ ] **Step 8.2: Add `submitWizard()` function**

```javascript
    function submitWizard() {
      wizardSaveBtn.disabled = true;
      wizardSaveBtn.textContent = 'Saving\u2026';
      wizardError.style.display = 'none';

      // Fetch current identity to preserve behavioral_preferences and constraints.
      fetch('/api/identity')
        .then(function(res) { return res.json(); })
        .then(function(data) {
          var current = data.identity;
          var prefs = current.behavioralPreferences ? current.behavioralPreferences.slice() : [];
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
            return res.json().then(function(body) {
              throw new Error(body.error || 'Save failed');
            });
          }
          return fetch('/api/identity/reload', { method: 'POST' });
        })
        .then(function() {
          hideWizard();
          if (mainApp && mainApp.style.display === 'none') {
            mainApp.style.display = 'flex';
            initCytoscape();
          }
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
```

- [ ] **Step 8.3: Run the full test suite**

```bash
pnpm test
```

Expected: all tests pass.

- [ ] **Step 8.4: Commit**

```bash
git add src/channels/http/routes/kg.ts
git commit -m "feat: wizard JS — review renderer, submit flow, success banner"
```

---

## Task 9: Changelog and version bump

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `package.json`

- [ ] **Step 9.1: Add to `CHANGELOG.md` under `## [Unreleased]`**

```markdown
### Added
- **Onboarding wizard** — multi-step full-screen wizard guides new users through configuring the office identity (assistant name, tone, communication style, decision posture) on first run. Re-enterable from Settings → Setup Wizard. Requires the identity service (spec 13) to be configured.
- **Settings nav** — new collapsible Settings section in the sidebar with Setup Wizard sub-item.
- **`configured` flag on `GET /api/identity`** — returns `false` until the wizard or API has saved an identity explicitly; used for first-run detection in the browser without client-side state.

### Changed
- **Default landing screen** — the app now lands on Chat instead of Knowledge Graph after login.
- **Session auth refactor** — `assertSecret()` extracted to `src/channels/http/session-auth.ts`; sessions store lifted to `HttpAdapter` so identity routes now accept the `curia_session` cookie in addition to the `x-web-bootstrap-secret` header.
```

- [ ] **Step 9.2: Bump the version in `package.json`**

Find the current version and increment the minor component (new feature = minor bump):

```json
"version": "0.9.0"
```

(Adjust base version to whatever the current value is + 1 minor.)

- [ ] **Step 9.3: Commit**

```bash
git add CHANGELOG.md package.json
git commit -m "chore: bump to 0.9.0; changelog for onboarding wizard"
```

---

## Manual Smoke Test Checklist

Run these checks against a local instance before opening the PR.

**First run:**
- [ ] Clear cookies → enter access key → wizard appears, main app is hidden
- [ ] Step 1: blank name field → Next blocked with error message; filled name → proceeds
- [ ] Step 2: select tone pills up to 3 — 4th is disabled; deselecting re-enables; live preview sentence updates
- [ ] Step 2: drag verbosity slider — sample sentence changes at each of the 4 bands
- [ ] Step 2: drag directness slider — sample sentence changes at each of the 4 bands
- [ ] Step 2: click posture cards — selected card gets border highlight; only one selected at a time
- [ ] Step 3: textarea optional; Next always proceeds
- [ ] Step 4: review card shows plain-English summaries (not raw values); freeform preference appears if entered
- [ ] Confirm & save → button shows "Saving…" → wizard dismisses → Chat view → teal success banner appears and auto-dismisses in 4 seconds
- [ ] `GET /api/identity` returns `configured: true` after completion
- [ ] Page refresh → lands on Chat, no wizard

**Re-entry:**
- [ ] Settings → Setup Wizard → wizard opens with current identity values pre-filled
- [ ] Completing re-entry → Chat view with success banner

**Navigation:**
- [ ] Settings section is collapsible (chevron animates)
- [ ] All existing nav items (Chat, Memory sub-items) work correctly
- [ ] Default post-login destination is Chat, not Knowledge Graph
