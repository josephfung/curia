# Autonomy Web UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dedicated "Autonomy" settings page to the web UI for viewing/adjusting the autonomy score, with paginated change history.

**Architecture:** New REST route file (`autonomy.ts`) following the identity/executive pattern, wired through `HttpAdapter`. Frontend view added to the single-page KG HTML. `AutonomyService` extended with pagination support.

**Tech Stack:** TypeScript/ESM, Fastify, PostgreSQL, vanilla JS frontend, Vitest

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/autonomy/autonomy-service.ts` | Modify | Add `getHistoryPaginated(limit, offset)` returning `{ rows, total }` |
| `src/channels/http/routes/autonomy.ts` | Create | GET/PUT `/api/autonomy`, GET `/api/autonomy/history` |
| `src/channels/http/http-adapter.ts` | Modify | Import + register autonomy routes, add to auth skip list, add to config interface |
| `src/index.ts` | Modify | Pass `autonomyService` to HttpAdapter config |
| `src/channels/http/routes/kg.ts` | Modify | Add nav item, view HTML, and JS logic for autonomy page |
| `tests/unit/autonomy/autonomy-service-pagination.test.ts` | Create | Unit tests for the new pagination method |
| `tests/integration/autonomy-routes.test.ts` | Create | Integration tests for autonomy REST endpoints |

---

### Task 1: Extend AutonomyService with Pagination

**Files:**
- Modify: `src/autonomy/autonomy-service.ts:220-243`
- Create: `tests/unit/autonomy/autonomy-service-pagination.test.ts`

- [ ] **Step 1: Write the failing test for `getHistoryPaginated`**

Create `tests/unit/autonomy/autonomy-service-pagination.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { AutonomyService } from '../../../src/autonomy/autonomy-service.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

describe('AutonomyService.getHistoryPaginated', () => {
  let pool: pg.Pool;
  let service: AutonomyService;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env['DATABASE_URL'] });
    service = new AutonomyService(pool, logger);

    // Ensure tables exist (migration 011)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS autonomy_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        score INTEGER NOT NULL DEFAULT 75,
        band TEXT NOT NULL DEFAULT 'approval-required',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_by TEXT NOT NULL DEFAULT 'system'
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS autonomy_history (
        id SERIAL PRIMARY KEY,
        score INTEGER NOT NULL,
        previous_score INTEGER,
        band TEXT NOT NULL,
        changed_by TEXT NOT NULL,
        reason TEXT,
        changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // Seed 8 history entries for pagination testing
    await pool.query('DELETE FROM autonomy_history');
    await pool.query('DELETE FROM autonomy_config');
    await pool.query(
      `INSERT INTO autonomy_config (id, score, band, updated_by) VALUES (1, 80, 'spot-check', 'test')`
    );
    for (let i = 1; i <= 8; i++) {
      await pool.query(
        `INSERT INTO autonomy_history (score, previous_score, band, changed_by, reason, changed_at)
         VALUES ($1, $2, $3, $4, $5, now() - interval '${9 - i} hours')`,
        [50 + i * 5, 50 + (i - 1) * 5, 'approval-required', 'test', `Change ${i}`]
      );
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  it('returns rows and total count with default limit/offset', async () => {
    const result = await service.getHistoryPaginated();
    expect(result.total).toBe(8);
    expect(result.rows.length).toBe(5); // default limit
    // Newest first
    expect(result.rows[0]!.reason).toBe('Change 8');
  });

  it('respects custom limit and offset', async () => {
    const result = await service.getHistoryPaginated(3, 2);
    expect(result.total).toBe(8);
    expect(result.rows.length).toBe(3);
    expect(result.rows[0]!.reason).toBe('Change 6'); // offset 2 from newest
  });

  it('returns empty rows when offset exceeds total', async () => {
    const result = await service.getHistoryPaginated(5, 100);
    expect(result.total).toBe(8);
    expect(result.rows.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-autonomy-ui test tests/unit/autonomy/autonomy-service-pagination.test.ts`

Expected: FAIL — `service.getHistoryPaginated is not a function`

- [ ] **Step 3: Implement `getHistoryPaginated` in AutonomyService**

Add this method after the existing `getHistory` method in `src/autonomy/autonomy-service.ts` (after line 243):

```typescript
  /**
   * Return paginated history entries (newest first) with total count.
   * Used by the web UI's "Show more" pagination.
   */
  async getHistoryPaginated(limit = 5, offset = 0): Promise<{ rows: AutonomyHistoryEntry[]; total: number }> {
    const countResult = await this.pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM autonomy_history',
    );
    const total = parseInt(countResult.rows[0]!.count, 10);

    const result = await this.pool.query<{
      id: number;
      score: number;
      previous_score: number | null;
      band: string;
      changed_by: string;
      reason: string | null;
      changed_at: Date;
    }>(
      'SELECT id, score, previous_score, band, changed_by, reason, changed_at FROM autonomy_history ORDER BY changed_at DESC LIMIT $1 OFFSET $2',
      [limit, offset],
    );

    return {
      total,
      rows: result.rows.map(row => ({
        id: row.id,
        score: row.score,
        previousScore: row.previous_score,
        band: row.band as AutonomyBand,
        changedBy: row.changed_by,
        reason: row.reason,
        changedAt: row.changed_at,
      })),
    };
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-autonomy-ui test tests/unit/autonomy/autonomy-service-pagination.test.ts`

Expected: PASS (all 3 tests)

- [ ] **Step 5: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-autonomy-ui add src/autonomy/autonomy-service.ts tests/unit/autonomy/autonomy-service-pagination.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-autonomy-ui commit -m "feat(autonomy): add getHistoryPaginated for web UI pagination (#409)"
```

---

### Task 2: Create Autonomy REST Routes

**Files:**
- Create: `src/channels/http/routes/autonomy.ts`
- Create: `tests/integration/autonomy-routes.test.ts`

- [ ] **Step 1: Write integration tests for the autonomy routes**

Create `tests/integration/autonomy-routes.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import pg from 'pg';
import pino from 'pino';
import { autonomyRoutes } from '../../src/channels/http/routes/autonomy.js';
import { AutonomyService } from '../../src/autonomy/autonomy-service.js';

const logger = pino({ level: 'silent' });

describe('Autonomy REST routes', () => {
  const app = Fastify();
  let pool: pg.Pool;
  let autonomyService: AutonomyService;

  // Fake session store — pre-seed a valid session token for tests.
  const sessions: Map<string, number> = new Map();
  const TEST_SECRET = 'test-bootstrap-secret';
  const AUTH_HEADER = { 'x-web-bootstrap-secret': TEST_SECRET };

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env['DATABASE_URL'] });
    autonomyService = new AutonomyService(pool, logger);

    // Ensure tables exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS autonomy_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        score INTEGER NOT NULL DEFAULT 75,
        band TEXT NOT NULL DEFAULT 'approval-required',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_by TEXT NOT NULL DEFAULT 'system'
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS autonomy_history (
        id SERIAL PRIMARY KEY,
        score INTEGER NOT NULL,
        previous_score INTEGER,
        band TEXT NOT NULL,
        changed_by TEXT NOT NULL,
        reason TEXT,
        changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // Reset state
    await pool.query('DELETE FROM autonomy_history');
    await pool.query('DELETE FROM autonomy_config');
    await pool.query(
      `INSERT INTO autonomy_config (id, score, band, updated_by) VALUES (1, 75, 'approval-required', 'test')`
    );

    await app.register(cookie);
    await app.register(autonomyRoutes, {
      autonomyService,
      webAppBootstrapSecret: TEST_SECRET,
      sessions,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  describe('GET /api/autonomy', () => {
    it('returns current autonomy config', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/autonomy',
        headers: AUTH_HEADER,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.autonomy.score).toBe(75);
      expect(body.autonomy.band).toBe('approval-required');
      expect(body.autonomy.bandDescription).toContain('consequential action');
    });

    it('returns 401 without auth', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/autonomy',
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('PUT /api/autonomy', () => {
    it('sets score and returns new config', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/autonomy',
        headers: { ...AUTH_HEADER, 'content-type': 'application/json' },
        payload: { score: 85, reason: 'Testing increase' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.autonomy.score).toBe(85);
      expect(body.autonomy.band).toBe('spot-check');
      expect(body.previousScore).toBe(75);
      expect(body.updated).toBe(true);
    });

    it('returns 400 for invalid score', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/autonomy',
        headers: { ...AUTH_HEADER, 'content-type': 'application/json' },
        payload: { score: 150 },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 for missing score', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/autonomy',
        headers: { ...AUTH_HEADER, 'content-type': 'application/json' },
        payload: { reason: 'no score provided' },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /api/autonomy/history', () => {
    it('returns paginated history with total', async () => {
      // The PUT above created 1 history entry
      const res = await app.inject({
        method: 'GET',
        url: '/api/autonomy/history?limit=5&offset=0',
        headers: AUTH_HEADER,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.history.length).toBeGreaterThanOrEqual(1);
      expect(typeof body.total).toBe('number');
      expect(body.history[0].changedBy).toBe('web-ui');
      expect(body.history[0].reason).toBe('Testing increase');
    });

    it('respects offset parameter', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/autonomy/history?limit=5&offset=100',
        headers: AUTH_HEADER,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.history.length).toBe(0);
      expect(body.total).toBeGreaterThanOrEqual(1);
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-autonomy-ui test tests/integration/autonomy-routes.test.ts`

Expected: FAIL — cannot resolve `../../src/channels/http/routes/autonomy.js`

- [ ] **Step 3: Create the autonomy route file**

Create `src/channels/http/routes/autonomy.ts`:

```typescript
// autonomy.ts — HTTP routes for the Autonomy Score API.
//
// All routes require session cookie or x-web-bootstrap-secret authentication
// (same pattern as identity/executive routes).
//
// Endpoints:
//   GET  /api/autonomy         — return the current autonomy config
//   PUT  /api/autonomy         — set the autonomy score
//   GET  /api/autonomy/history — return paginated history entries

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AutonomyService } from '../../../autonomy/autonomy-service.js';
import { assertSecret, type SessionStore } from '../session-auth.js';

export interface AutonomyRouteOptions {
  autonomyService: AutonomyService;
  webAppBootstrapSecret: string;
  sessions: SessionStore;
}

export async function autonomyRoutes(
  app: FastifyInstance,
  options: AutonomyRouteOptions,
): Promise<void> {
  const { autonomyService, webAppBootstrapSecret, sessions } = options;

  function requireAuth(request: FastifyRequest, reply: FastifyReply): boolean {
    return assertSecret(request, reply, webAppBootstrapSecret, sessions);
  }

  // -- GET /api/autonomy — return current autonomy config --

  app.get('/api/autonomy', async (request, reply) => {
    if (!requireAuth(request, reply)) return;

    try {
      const config = await autonomyService.getConfig();
      if (!config) {
        return reply.send({ autonomy: null });
      }
      return reply.send({
        autonomy: {
          score: config.score,
          band: config.band,
          bandDescription: AutonomyService.bandDescription(config.band),
          updatedAt: config.updatedAt,
          updatedBy: config.updatedBy,
        },
      });
    } catch (err) {
      request.log.error({ err }, 'GET /api/autonomy: failed to get config');
      return reply.status(500).send({ error: 'Failed to get autonomy config. Check server logs.' });
    }
  });

  // -- PUT /api/autonomy — set the autonomy score --

  app.put('/api/autonomy', async (request, reply) => {
    if (!requireAuth(request, reply)) return;

    const body = request.body as { score?: number; reason?: string } | null;

    if (body?.score === undefined || body.score === null) {
      return reply.status(400).send({ error: 'Request body must include a "score" field (integer 0-100)' });
    }

    try {
      const result = await autonomyService.setScore(body.score, 'web-ui', body.reason);
      return reply.send({
        autonomy: {
          score: result.score,
          band: result.band,
          bandDescription: AutonomyService.bandDescription(result.band),
          updatedAt: result.updatedAt,
          updatedBy: result.updatedBy,
        },
        previousScore: result.previousScore,
        updated: true,
      });
    } catch (err) {
      // AutonomyService.setScore throws for validation errors (score out of range)
      const message = err instanceof Error ? err.message : 'Failed to set autonomy score';
      if (message.includes('Invalid autonomy score')) {
        return reply.status(400).send({ error: message });
      }
      request.log.error({ err }, 'PUT /api/autonomy: failed to set score');
      return reply.status(500).send({ error: 'Failed to set autonomy score. Check server logs.' });
    }
  });

  // -- GET /api/autonomy/history — return paginated history --

  app.get('/api/autonomy/history', async (request, reply) => {
    if (!requireAuth(request, reply)) return;

    const query = request.query as { limit?: string; offset?: string };
    const limit = Math.min(Math.max(parseInt(query.limit ?? '5', 10) || 5, 1), 50);
    const offset = Math.max(parseInt(query.offset ?? '0', 10) || 0, 0);

    try {
      const { rows, total } = await autonomyService.getHistoryPaginated(limit, offset);
      return reply.send({
        history: rows.map(entry => ({
          id: entry.id,
          score: entry.score,
          previousScore: entry.previousScore,
          band: entry.band,
          changedBy: entry.changedBy,
          reason: entry.reason,
          changedAt: entry.changedAt,
        })),
        total,
      });
    } catch (err) {
      request.log.error({ err }, 'GET /api/autonomy/history: failed to retrieve history');
      return reply.status(500).send({ error: 'Failed to get autonomy history. Check server logs.' });
    }
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-autonomy-ui test tests/integration/autonomy-routes.test.ts`

Expected: PASS (all 6 tests)

- [ ] **Step 5: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-autonomy-ui add src/channels/http/routes/autonomy.ts tests/integration/autonomy-routes.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-autonomy-ui commit -m "feat(http): add autonomy REST endpoints (#409)"
```

---

### Task 3: Wire Autonomy Routes into HttpAdapter

**Files:**
- Modify: `src/channels/http/http-adapter.ts:34` (import), `41-55` (config interface), `119-126` (auth skip), `166-183` (registration)
- Modify: `src/index.ts:1066-1081` (pass autonomyService)

- [ ] **Step 1: Add import to http-adapter.ts**

Add after line 34 (`import { executiveRoutes } from './routes/executive.js';`):

```typescript
import { autonomyRoutes } from './routes/autonomy.js';
```

- [ ] **Step 2: Add `autonomyService` to `HttpAdapterConfig` interface**

Add after the `contactService: ContactService;` line in the interface:

```typescript
  autonomyService?: AutonomyService;
```

And add the import at the top (after the existing `import type { ContactService }` line):

```typescript
import type { AutonomyService } from '../../autonomy/autonomy-service.js';
```

- [ ] **Step 3: Add `/api/autonomy` to the auth skip list**

In the `onRequest` hook (around line 119-126), add `routeUrl.startsWith('/api/autonomy')` to the skip condition:

```typescript
      if (
        routeUrl === '/' ||
        routeUrl === '/auth' ||
        routeUrl.startsWith('/assets') ||
        routeUrl.startsWith('/api/kg') ||
        routeUrl.startsWith('/api/identity') ||
        routeUrl.startsWith('/api/jobs') ||
        routeUrl.startsWith('/api/autonomy')
      ) return;
```

- [ ] **Step 4: Register autonomy routes**

Add after the executive routes registration block (after line ~183), following the same pattern:

```typescript
    // Autonomy routes — same auth pattern as identity/executive routes.
    if (webAppBootstrapSecret && this.config.autonomyService) {
      await this.app.register(autonomyRoutes, {
        autonomyService: this.config.autonomyService,
        webAppBootstrapSecret,
        sessions,
      });
    }
```

- [ ] **Step 5: Pass autonomyService in src/index.ts**

In `src/index.ts` at the `new HttpAdapter({...})` call (line ~1066), add `autonomyService` to the config object:

```typescript
  const httpAdapter = new HttpAdapter({
    bus,
    logger,
    pool,
    agentRegistry,
    port: config.httpPort,
    apiToken: config.apiToken,
    webAppBootstrapSecret: config.webAppBootstrapSecret,
    appOrigin: config.appOrigin,
    agentNames: agentConfigs.map(c => c.name),
    skillNames: skillRegistry.list().map(s => s.manifest.name),
    schedulerService,
    identityService: officeIdentityService,
    executiveProfileService,
    contactService,
    autonomyService,
  });
```

- [ ] **Step 6: Run the full test suite to confirm nothing is broken**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-autonomy-ui test`

Expected: All tests pass (existing + new)

- [ ] **Step 7: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-autonomy-ui add src/channels/http/http-adapter.ts src/index.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-autonomy-ui commit -m "feat(http): wire autonomy routes into HttpAdapter (#409)"
```

---

### Task 4: Add Autonomy View to Frontend (HTML + CSS)

**Files:**
- Modify: `src/channels/http/routes/kg.ts` (nav item at ~line 1060, view HTML after ~line 1316, CSS)

- [ ] **Step 1: Add the nav item under Settings submenu**

In `kg.ts`, inside the `settings-submenu` div (after the Setup Wizard button, around line 1071), add:

```html
            <button id="nav-autonomy" class="nav-sub-item" onclick="navigate('autonomy', 'Autonomy', 'nav-autonomy')">
              <!-- gauge/dial icon -->
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M6.5 11.5a5 5 0 1 1 0-10 5 5 0 0 1 0 10z"/>
                <path d="M6.5 3.5v1"/>
                <path d="M6.5 6.5l2-2"/>
              </svg>
              Autonomy
            </button>
```

- [ ] **Step 2: Add the view HTML**

After the `view-scheduled-jobs` closing `</div>` (around line 1316) and before the `view-chat` div, add:

```html
      <!-- Autonomy settings view — hidden until user clicks the Autonomy nav item -->
      <div id="view-autonomy" style="display: none; height: 100%; flex-direction: column; overflow-y: auto; padding: 24px 32px; max-width: 720px;">

        <h2 style="font-family: 'Lora', Georgia, serif; font-size: 1.375rem; font-weight: 500; margin: 0 0 24px;">Autonomy</h2>

        <!-- Current state display -->
        <div id="autonomy-current" style="margin-bottom: 28px;">
          <div style="display: flex; align-items: baseline; gap: 12px; margin-bottom: 8px;">
            <span id="autonomy-score-display" style="font-size: 2rem; font-weight: 700; color: var(--fg);"></span>
            <span id="autonomy-band-badge" class="badge"></span>
          </div>
          <p id="autonomy-band-description" style="font-size: 0.875rem; color: var(--fg-muted); margin: 0; line-height: 1.5;"></p>
        </div>

        <!-- Score adjustment control -->
        <div style="margin-bottom: 32px; padding: 20px; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-lg);">
          <div style="font-size: 0.6875rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: var(--fg-muted); margin-bottom: 12px;">Adjust Score</div>
          <input id="autonomy-slider" type="range" min="0" max="100" step="1" value="75"
            style="width: 100%; accent-color: var(--primary); margin-bottom: 6px;" />
          <div class="slider-labels"><span>Restricted</span><span>Full</span></div>

          <div style="margin-top: 16px;">
            <label for="autonomy-reason" style="display: block; font-size: 0.6875rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: var(--fg-muted); margin-bottom: 6px;">Reason (optional)</label>
            <textarea id="autonomy-reason" rows="2" placeholder="Reason for change (optional)" style="width: 100%; resize: vertical;"></textarea>
          </div>

          <button id="autonomy-save-btn" class="btn-primary" disabled style="margin-top: 12px;">Save</button>
          <span id="autonomy-save-status" style="font-size: 0.75rem; color: var(--fg-muted); margin-left: 10px;"></span>
        </div>

        <!-- History section -->
        <div>
          <div style="font-size: 0.6875rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: var(--fg-muted); margin-bottom: 12px;">Recent Changes</div>
          <div id="autonomy-history-list" style="display: flex; flex-direction: column; gap: 8px;"></div>
          <button id="autonomy-show-more-btn" class="btn-primary" style="margin-top: 12px; display: none; background: var(--muted); color: var(--fg);">Show more</button>
        </div>
      </div>
```

- [ ] **Step 3: Add autonomy-specific CSS**

In the `<style>` section of kg.ts (near the existing `.slider-labels` rule around line 822), add:

```css
    .autonomy-history-entry {
      padding: 10px 14px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
    }
    .autonomy-history-entry .score-change {
      font-weight: 600;
      font-size: 0.875rem;
    }
    .autonomy-history-entry .meta {
      font-size: 0.75rem;
      color: var(--fg-muted);
      margin-top: 3px;
    }
    .autonomy-history-entry .reason {
      font-size: 0.8125rem;
      font-style: italic;
      color: var(--fg-muted);
      margin-top: 4px;
    }
```

- [ ] **Step 4: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-autonomy-ui add src/channels/http/routes/kg.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-autonomy-ui commit -m "feat(ui): add autonomy view HTML and nav item (#409)"
```

---

### Task 5: Add Autonomy View JavaScript Logic

**Files:**
- Modify: `src/channels/http/routes/kg.ts` (JS section, within the `<script>` block)

- [ ] **Step 1: Add view-autonomy to the navigate() function**

In the `navigate()` function (around line 1838), add `view-autonomy` to the view list. After the existing variable declarations (line ~1844), add:

```javascript
      var autonomyView    = document.getElementById('view-autonomy');
```

In the display toggle section (around line 1872), add:

```javascript
      autonomyView.style.display     = view === 'autonomy'        ? 'flex' : 'none';
```

And add the view-load trigger (after the `if (view === 'scheduled-jobs')` block):

```javascript
      if (view === 'autonomy') {
        loadAutonomy();
      }
```

- [ ] **Step 2: Add band helper functions and state variables**

Add these after the existing variable declarations section (after `var activeNavId = 'nav-kg';` area):

```javascript
    // -- Autonomy state --
    var autonomySavedScore = null; // last-saved score (to detect changes)
    var autonomyHistoryOffset = 0;
    var autonomyHistoryTotal = 0;

    var AUTONOMY_BANDS = {
      'full':              { label: 'Full',              color: '#5E9E6B', description: 'Act independently. No confirmation needed for standard operations. Flag only genuinely novel, irreversible, or high-stakes actions \u2014 where the downside of acting without checking outweighs the cost of the pause.' },
      'spot-check':        { label: 'Spot-check',       color: '#6BAED6', description: 'Proceed on routine tasks. For consequential actions \u2014 sending external communications, creating commitments, or acting on behalf of the CEO \u2014 note what you are doing in your response so the CEO maintains visibility. No need to stop and ask.' },
      'approval-required': { label: 'Approval Required', color: '#C9874A', description: 'For any consequential action, present your plan and explicitly ask for confirmation before proceeding. Routine reporting, summarization, and information retrieval can proceed without approval. When in doubt, draft and ask.' },
      'draft-only':        { label: 'Draft Only',       color: '#7E6BA8', description: 'Prepare drafts, plans, and analysis, but do not send, publish, schedule, or act on behalf of the CEO without an explicit instruction to do so. Surface your work for review; execution requires a direct go-ahead.' },
      'restricted':        { label: 'Restricted',       color: '#E86040', description: 'Present options and analysis only. Take no independent action. All outputs are advisory. Every step that would have an external effect requires explicit CEO instruction.' },
    };

    function bandForScore(score) {
      if (score >= 90) return 'full';
      if (score >= 80) return 'spot-check';
      if (score >= 70) return 'approval-required';
      if (score >= 60) return 'draft-only';
      return 'restricted';
    }

    function timeAgo(dateStr) {
      var now = Date.now();
      var then = new Date(dateStr).getTime();
      var seconds = Math.floor((now - then) / 1000);
      if (seconds < 60) return 'just now';
      var minutes = Math.floor(seconds / 60);
      if (minutes < 60) return minutes + 'm ago';
      var hours = Math.floor(minutes / 60);
      if (hours < 24) return hours + 'h ago';
      var days = Math.floor(hours / 24);
      return days + 'd ago';
    }
```

- [ ] **Step 3: Add the main autonomy loading and interaction functions**

Add after the band helper functions. All dynamic content uses `textContent` and safe DOM construction (no innerHTML with untrusted data):

```javascript
    // -- Autonomy functions --

    function loadAutonomy() {
      fetch('/api/autonomy')
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (!data.autonomy) {
            document.getElementById('autonomy-current').textContent =
              'Autonomy not configured. Run migration 011 first.';
            return;
          }
          autonomySavedScore = data.autonomy.score;
          renderAutonomyState(data.autonomy.score, data.autonomy.band, data.autonomy.bandDescription);
          document.getElementById('autonomy-slider').value = data.autonomy.score;
        });

      // Load history
      autonomyHistoryOffset = 0;
      document.getElementById('autonomy-history-list').replaceChildren();
      loadAutonomyHistory();
    }

    function renderAutonomyState(score, band, description) {
      var bandInfo = AUTONOMY_BANDS[band] || { label: band, color: '#999' };
      document.getElementById('autonomy-score-display').textContent = score;
      var badge = document.getElementById('autonomy-band-badge');
      badge.textContent = bandInfo.label;
      badge.style.background = bandInfo.color + '22';
      badge.style.color = bandInfo.color;
      badge.style.border = '1px solid ' + bandInfo.color + '44';
      document.getElementById('autonomy-band-description').textContent = description;
    }

    function buildHistoryEntry(entry) {
      var bandInfo = AUTONOMY_BANDS[entry.band] || { label: entry.band, color: '#999' };
      var div = document.createElement('div');
      div.className = 'autonomy-history-entry';

      // Score change line
      var scoreDiv = document.createElement('div');
      scoreDiv.className = 'score-change';
      var scoreText = (entry.previousScore !== null)
        ? entry.previousScore + ' \u2192 ' + entry.score
        : '\u2014 \u2192 ' + entry.score;
      scoreDiv.appendChild(document.createTextNode(scoreText + ' '));
      var badge = document.createElement('span');
      badge.className = 'badge';
      badge.style.fontSize = '0.6875rem';
      badge.style.background = bandInfo.color + '22';
      badge.style.color = bandInfo.color;
      badge.style.border = '1px solid ' + bandInfo.color + '44';
      badge.textContent = bandInfo.label;
      scoreDiv.appendChild(badge);
      div.appendChild(scoreDiv);

      // Meta line (who + when)
      var metaDiv = document.createElement('div');
      metaDiv.className = 'meta';
      metaDiv.textContent = entry.changedBy + ' \u00b7 ' + timeAgo(entry.changedAt);
      div.appendChild(metaDiv);

      // Reason (if present)
      if (entry.reason) {
        var reasonDiv = document.createElement('div');
        reasonDiv.className = 'reason';
        reasonDiv.textContent = entry.reason;
        div.appendChild(reasonDiv);
      }

      return div;
    }

    function loadAutonomyHistory() {
      fetch('/api/autonomy/history?limit=5&offset=' + autonomyHistoryOffset)
        .then(function(res) { return res.json(); })
        .then(function(data) {
          autonomyHistoryTotal = data.total;
          var list = document.getElementById('autonomy-history-list');
          data.history.forEach(function(entry) {
            list.appendChild(buildHistoryEntry(entry));
          });
          autonomyHistoryOffset += data.history.length;

          // Show/hide "Show more" button
          var btn = document.getElementById('autonomy-show-more-btn');
          btn.style.display = (autonomyHistoryOffset < autonomyHistoryTotal) ? 'inline-block' : 'none';
        });
    }

    function saveAutonomy() {
      var score = parseInt(document.getElementById('autonomy-slider').value, 10);
      var reason = document.getElementById('autonomy-reason').value.trim() || undefined;
      var saveBtn = document.getElementById('autonomy-save-btn');
      var status = document.getElementById('autonomy-save-status');
      saveBtn.disabled = true;
      status.textContent = 'Saving\u2026';

      fetch('/api/autonomy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ score: score, reason: reason }),
      })
        .then(function(res) {
          if (!res.ok) return res.json().then(function(d) { throw new Error(d.error); });
          return res.json();
        })
        .then(function(data) {
          autonomySavedScore = data.autonomy.score;
          renderAutonomyState(data.autonomy.score, data.autonomy.band, data.autonomy.bandDescription);
          document.getElementById('autonomy-reason').value = '';
          status.textContent = 'Saved';
          setTimeout(function() { status.textContent = ''; }, 2000);

          // Prepend new entry to history list
          var newEntry = {
            score: data.autonomy.score,
            previousScore: data.previousScore,
            band: data.autonomy.band,
            changedBy: 'web-ui',
            changedAt: new Date().toISOString(),
            reason: reason || null,
          };
          var list = document.getElementById('autonomy-history-list');
          list.insertBefore(buildHistoryEntry(newEntry), list.firstChild);
          autonomyHistoryTotal++;
          autonomyHistoryOffset++;
        })
        .catch(function(err) {
          status.textContent = 'Error: ' + err.message;
          saveBtn.disabled = false;
        });
    }
```

- [ ] **Step 4: Wire up event listeners**

Add after the autonomy functions (in the initialization section, near other event bindings):

```javascript
    // -- Autonomy event bindings --

    document.getElementById('autonomy-slider').addEventListener('input', function() {
      var score = parseInt(this.value, 10);
      var band = bandForScore(score);
      var bandInfo = AUTONOMY_BANDS[band];
      renderAutonomyState(score, band, bandInfo.description);
      document.getElementById('autonomy-save-btn').disabled = (score === autonomySavedScore);
    });

    document.getElementById('autonomy-save-btn').addEventListener('click', function() {
      saveAutonomy();
    });

    document.getElementById('autonomy-show-more-btn').addEventListener('click', function() {
      loadAutonomyHistory();
    });
```

- [ ] **Step 5: Run typecheck**

Run: `npx --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-autonomy-ui tsc --noEmit`

Expected: Clean (no errors)

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-autonomy-ui add src/channels/http/routes/kg.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-autonomy-ui commit -m "feat(ui): add autonomy view JavaScript logic (#409)"
```

---

### Task 6: Manual Verification and Full Test Run

**Files:** None (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-autonomy-ui test`

Expected: All tests pass (existing + 2 new test files)

- [ ] **Step 2: Start the dev server and verify the UI**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-autonomy-ui run dev`

Verify in browser:
1. "Autonomy" appears in Settings nav group below "Setup Wizard"
2. Clicking it shows the autonomy view with current score, band badge, description
3. Slider updates preview in real-time (band label + description change)
4. Save button enables only when slider differs from saved value
5. Save persists the score (refresh page to confirm)
6. History shows entries with score change, band, who, when, reason
7. "Show more" loads additional entries (hidden when no more exist)
8. Auth: opening `/api/autonomy` directly without session returns 401

- [ ] **Step 3: Run typecheck**

Run: `npx --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-autonomy-ui tsc --noEmit`

Expected: Clean

---

### Task 7: Update CHANGELOG and Create PR

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add changelog entry under `## [Unreleased]`**

Add under the appropriate section heading (create `### Added` if needed):

```markdown
- **Autonomy web UI** — dedicated settings page for viewing and adjusting the autonomy score, with paginated change history. New REST endpoints: `GET/PUT /api/autonomy`, `GET /api/autonomy/history`. Closes #409.
```

- [ ] **Step 2: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-autonomy-ui add CHANGELOG.md
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-autonomy-ui commit -m "docs: add changelog entry for autonomy web UI (#409)"
```

- [ ] **Step 3: Push and create PR**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-autonomy-ui push -u origin feat/autonomy-ui
```

Then create the PR targeting `main` referencing issue #409.
