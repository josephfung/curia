# Web Browser Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `web-browser` skill powered by a warm Playwright Chromium instance that gives Curia a real JS-capable browser for dynamic pages, form flows, and sites with no API.

**Architecture:** A `BrowserService` (instantiated in `src/index.ts`, injected via `SkillContext`) holds a single warm Playwright browser and a `Map<sessionId, BrowserSession>` with TTL-based cleanup. The `web-browser` skill handler dispatches primitive actions (navigate, click, type, etc.) through this service. The LLM drives navigation logic via its tool-use loop; the skill provides the browser hands.

**Tech Stack:** Playwright (Chromium), `@cliqz/adblocker-playwright`, Node 22+, TypeScript ESM, Vitest

---

## File Map

**Create:**
- `src/browser/types.ts` — shared types: `BrowserActionResult`, `SessionId`
- `src/browser/browser-session.ts` — `BrowserSession` class (BrowserContext + Page + TTL)
- `src/browser/browser-service.ts` — `BrowserService` class (warm browser + session map)
- `src/browser/browser-service.test.ts` — unit tests (mocked browser) + integration tests (gated)
- `skills/web-browser/skill.json` — skill manifest
- `skills/web-browser/handler.ts` — action dispatcher + DOM cleaner
- `tests/unit/skills/web-browser.test.ts` — handler unit tests (mocked `BrowserService`)

**Modify:**
- `src/skills/types.ts` — add `browserService?: BrowserService` to `SkillContext`
- `src/skills/execution.ts` — add `browserService` to constructor options and inject into ctx
- `src/index.ts` — instantiate `BrowserService`, pass to `ExecutionLayer`, add to shutdown
- `config/default.yaml` — add `browser.sessionTtlMs` and `browser.sweepIntervalMs`
- `agents/coordinator.yaml` — add `web-browser` to `pinned_skills`

---

### Task 1: Install dependencies and install Chromium browser

**Files:**
- Modify: `package.json` (via pnpm)

- [ ] **Step 1: Install npm packages**

```bash
cd /path/to/curia  # your worktree
pnpm add playwright @cliqz/adblocker-playwright
```

- [ ] **Step 2: Install the Chromium browser binary**

Playwright separates the npm package from the browser binary. This downloads Chromium (~150MB) to `~/.cache/ms-playwright/`.

```bash
pnpm exec playwright install chromium
```

Expected output ends with: `✓ Chromium X.X.X (playwright build vXXXX) downloaded`

- [ ] **Step 3: Verify installation**

```bash
node --input-type=module <<'EOF'
import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto('https://example.com');
console.log('title:', await page.title());
await browser.close();
EOF
```

Expected output: `title: Example Domain`

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: add playwright and adblocker-playwright dependencies"
```

---

### Task 2: Create `src/browser/types.ts`

**Files:**
- Create: `src/browser/types.ts`

- [ ] **Step 1: Create the types file**

```typescript
// src/browser/types.ts — shared types for the browser subsystem.
//
// These types define the contract between BrowserService and the web-browser
// skill handler. Keeping them separate avoids circular imports between
// browser-service.ts and handler.ts.

/** Opaque session identifier returned by BrowserService and threaded by the LLM. */
export type SessionId = string;

/**
 * The set of actions the web-browser skill can perform.
 * Each action maps to a single Playwright operation.
 */
export type BrowserAction =
  | 'navigate'
  | 'click'
  | 'type'
  | 'select'
  | 'get_content'
  | 'screenshot'
  | 'close_session';
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
pnpm typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/browser/types.ts
git commit -m "feat: add browser subsystem types"
```

---

### Task 3: Create `src/browser/browser-session.ts`

**Files:**
- Create: `src/browser/browser-session.ts`

- [ ] **Step 1: Create the session wrapper**

```typescript
// src/browser/browser-session.ts — wraps a Playwright BrowserContext + Page with TTL tracking.
//
// Each BrowserSession is an isolated browser context (separate cookies, storage, cache)
// with a single active page. The TTL is refreshed on every use; sessions expire
// automatically via the BrowserService sweep interval.

import type { BrowserContext, Page } from 'playwright';

export class BrowserSession {
  readonly context: BrowserContext;
  readonly page: Page;
  /** Epoch ms of last access — updated by BrowserService.getOrCreateSession() on reuse. */
  lastUsedAt: number;

  constructor(context: BrowserContext, page: Page) {
    this.context = context;
    this.page = page;
    this.lastUsedAt = Date.now();
  }

  /** Returns true if the session has been idle longer than ttlMs. */
  isExpired(ttlMs: number): boolean {
    return Date.now() - this.lastUsedAt > ttlMs;
  }

  /** Close the underlying browser context, releasing all associated resources. */
  async close(): Promise<void> {
    await this.context.close();
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
pnpm typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/browser/browser-session.ts
git commit -m "feat: add BrowserSession wrapper"
```

---

### Task 4: Write failing BrowserService unit tests

**Files:**
- Create: `src/browser/browser-service.test.ts`

- [ ] **Step 1: Create the test file**

```typescript
// src/browser/browser-service.test.ts — BrowserService unit tests (mocked Playwright)
// and integration tests (real browser, gated behind RUN_BROWSER_TESTS=1).
//
// Unit tests inject a fake browser factory so no real Playwright process is needed.
// Integration tests spin up a real Chromium instance — run them with:
//   RUN_BROWSER_TESTS=1 pnpm test src/browser/browser-service.test.ts

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BrowserService } from './browser-service.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

// --- Mock Playwright objects ---

function makeMockPage() {
  return {
    on: vi.fn(),
    goto: vi.fn().mockResolvedValue(null),
    click: vi.fn().mockResolvedValue(null),
    fill: vi.fn().mockResolvedValue(null),
    selectOption: vi.fn().mockResolvedValue(null),
    evaluate: vi.fn().mockResolvedValue('page content'),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('fake-png')),
    url: vi.fn().mockReturnValue('https://example.com'),
    getByText: vi.fn().mockReturnValue({ click: vi.fn().mockResolvedValue(null) }),
    getByRole: vi.fn().mockReturnValue({ click: vi.fn().mockResolvedValue(null), fill: vi.fn().mockResolvedValue(null) }),
    getByLabel: vi.fn().mockReturnValue({ click: vi.fn().mockResolvedValue(null), fill: vi.fn().mockResolvedValue(null) }),
    locator: vi.fn().mockReturnValue({ click: vi.fn().mockResolvedValue(null), fill: vi.fn().mockResolvedValue(null), selectOption: vi.fn().mockResolvedValue(null) }),
  };
}

function makeMockContext(page: ReturnType<typeof makeMockPage>) {
  return {
    newPage: vi.fn().mockResolvedValue(page),
    close: vi.fn().mockResolvedValue(undefined),
    route: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  };
}

function makeMockBrowser(context: ReturnType<typeof makeMockContext>) {
  return {
    newContext: vi.fn().mockResolvedValue(context),
    isConnected: vi.fn().mockReturnValue(true),
    close: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  };
}

// --- Unit tests ---

describe('BrowserService (unit — mocked browser)', () => {
  let service: BrowserService;
  let mockPage: ReturnType<typeof makeMockPage>;
  let mockContext: ReturnType<typeof makeMockContext>;
  let mockBrowser: ReturnType<typeof makeMockBrowser>;

  beforeEach(async () => {
    mockPage = makeMockPage();
    mockContext = makeMockContext(mockPage);
    mockBrowser = makeMockBrowser(mockContext);

    service = new BrowserService({
      logger,
      sessionTtlMs: 1000,
      sweepIntervalMs: 60000,
      // Inject fake browser so no real Playwright process is needed
      browserFactory: async () => mockBrowser as never,
    });
    await service.start();
  });

  afterEach(async () => {
    await service.stop();
  });

  it('creates a new session when no session_id is provided', async () => {
    const result = await service.getOrCreateSession(undefined);
    expect(result.sessionId).toBeTruthy();
    expect(typeof result.sessionId).toBe('string');
    expect(mockBrowser.newContext).toHaveBeenCalledOnce();
  });

  it('reuses an existing session when a valid session_id is provided', async () => {
    const first = await service.getOrCreateSession(undefined);
    const second = await service.getOrCreateSession(first.sessionId);
    expect(second.sessionId).toBe(first.sessionId);
    // newContext called only once — second call reused existing session
    expect(mockBrowser.newContext).toHaveBeenCalledOnce();
  });

  it('creates a fresh session when the provided session_id has expired', async () => {
    const first = await service.getOrCreateSession(undefined);

    // Manually expire the session by backdating lastUsedAt
    const session = service.getSession(first.sessionId);
    session!.lastUsedAt = Date.now() - 5000; // well past 1000ms TTL

    const second = await service.getOrCreateSession(first.sessionId);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(mockBrowser.newContext).toHaveBeenCalledTimes(2);
    expect(mockContext.close).toHaveBeenCalledOnce();
  });

  it('closeSession() closes the context and removes the session', async () => {
    const { sessionId } = await service.getOrCreateSession(undefined);
    await service.closeSession(sessionId);
    expect(mockContext.close).toHaveBeenCalledOnce();
    expect(service.getSession(sessionId)).toBeUndefined();
  });

  it('sweep removes expired sessions', async () => {
    const { sessionId } = await service.getOrCreateSession(undefined);

    // Backdating makes this session eligible for sweep
    const session = service.getSession(sessionId);
    session!.lastUsedAt = Date.now() - 5000;

    await service.sweep();
    expect(service.getSession(sessionId)).toBeUndefined();
    expect(mockContext.close).toHaveBeenCalledOnce();
  });

  it('stop() closes all sessions and the browser', async () => {
    await service.getOrCreateSession(undefined);
    await service.getOrCreateSession(undefined); // two sessions
    await service.stop();
    expect(mockContext.close).toHaveBeenCalledTimes(2);
    expect(mockBrowser.close).toHaveBeenCalledOnce();
  });
});

// --- Integration tests (real browser) ---

const runBrowserTests = !!process.env.RUN_BROWSER_TESTS;

describe.skipIf(!runBrowserTests)('BrowserService (integration — real Chromium)', () => {
  let service: BrowserService;

  beforeEach(async () => {
    service = new BrowserService({ logger, sessionTtlMs: 30000, sweepIntervalMs: 60000 });
    await service.start();
  });

  afterEach(async () => {
    await service.stop();
  });

  it('creates a session and navigates to example.com', async () => {
    const { sessionId, session } = await service.getOrCreateSession(undefined);
    await session.page.goto('https://example.com');
    const title = await session.page.title();
    expect(title).toContain('Example');
    await service.closeSession(sessionId);
  });

  it('session state persists across getOrCreateSession calls', async () => {
    const first = await service.getOrCreateSession(undefined);
    await first.session.page.goto('https://example.com');
    const second = await service.getOrCreateSession(first.sessionId);
    // Same page instance — same URL
    expect(second.session.page.url()).toBe('https://example.com/');
  });
});
```

- [ ] **Step 2: Run the tests — they must fail** (BrowserService does not exist yet)

```bash
pnpm test src/browser/browser-service.test.ts
```

Expected: FAIL with `Cannot find module './browser-service.js'`

- [ ] **Step 3: Commit the failing tests**

```bash
git add src/browser/browser-service.test.ts
git commit -m "test: add failing BrowserService unit tests"
```

---

### Task 5: Create `src/browser/browser-service.ts`

**Files:**
- Create: `src/browser/browser-service.ts`

- [ ] **Step 1: Create BrowserService**

```typescript
// src/browser/browser-service.ts — manages a warm Playwright browser and session map.
//
// A single Chromium browser process is launched at startup and kept warm.
// Each session gets its own isolated BrowserContext (separate cookies/storage).
// Sessions expire after sessionTtlMs of inactivity and are swept on an interval.
//
// SCALABILITY @TODO: This implementation runs a single Playwright browser in-process.
// To scale to higher concurrency or add crash isolation:
//
// 1. Browser pool: run N browsers, round-robin sessions across them.
//    Add a pool size config and a simple round-robin or least-loaded assignment strategy.
//
// 2. Sidecar process: move BrowserService behind a local HTTP/WebSocket interface.
//    The skill calls it over localhost. Crash isolation: a browser crash can't take
//    down Curia. playwright-server is a reference implementation.
//
// 3. Managed service: connect to Browserless.io or ScrapingBee via WebSocket.
//    They handle Xvfb, stealth fingerprinting, CAPTCHA solving, and scaling externally.
//    Browserless.io is a drop-in replacement — only the launch/connect call changes.
//    Drop the Xvfb management entirely when using a managed service.
//
// For options 2 and 3, only this file needs to change — the handler,
// session model, and SkillContext interface are unaffected.

import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { chromium, type Browser } from 'playwright';
import { PlaywrightBlocker } from '@cliqz/adblocker-playwright';
import type { Logger } from '../logger.js';
import { BrowserSession } from './browser-session.js';
import type { SessionId } from './types.js';

interface BrowserServiceOptions {
  logger: Logger;
  /** Session idle TTL in ms. Default: 600_000 (10 minutes). */
  sessionTtlMs?: number;
  /** How often to sweep expired sessions in ms. Default: 120_000 (2 minutes). */
  sweepIntervalMs?: number;
  /**
   * Optional factory to create the Browser instance.
   * Defaults to `chromium.launch(...)`. Override in tests to inject a mock.
   */
  browserFactory?: () => Promise<Browser>;
}

export class BrowserService {
  private logger: Logger;
  private sessionTtlMs: number;
  private sweepIntervalMs: number;
  private browserFactory: () => Promise<Browser>;

  private browser: Browser | null = null;
  private blocker: PlaywrightBlocker | null = null;
  private sessions: Map<SessionId, BrowserSession> = new Map();
  private sweepTimer: NodeJS.Timeout | null = null;
  private xvfbProcess: ChildProcess | null = null;

  constructor(options: BrowserServiceOptions) {
    this.logger = options.logger.child({ service: 'BrowserService' });
    this.sessionTtlMs = options.sessionTtlMs ?? 600_000;
    this.sweepIntervalMs = options.sweepIntervalMs ?? 120_000;
    this.browserFactory = options.browserFactory ?? (() => this.launchChromium());
  }

  /**
   * Start the browser service: spawn Xvfb if needed, launch Chromium, start sweep timer.
   * Must be called before any session operations.
   */
  async start(): Promise<void> {
    await this.maybeStartXvfb();
    this.browser = await this.browserFactory();

    // Initialize ad blocker once at startup — downloads and caches EasyList/EasyPrivacy
    // filter lists. Each new BrowserContext gets the blocker applied on creation.
    // This reduces page load time, DOM noise, and token cost from cleaned content.
    try {
      this.blocker = await PlaywrightBlocker.fromPrebuiltAdsAndTracking(fetch);
      this.logger.info('Ad blocker initialized');
    } catch (err) {
      // Non-fatal: log and continue. Pages will load with ads but still work correctly.
      this.logger.warn({ err }, 'Ad blocker failed to initialize — continuing without ad blocking');
    }

    // Restart browser automatically on disconnect (e.g., OOM kill)
    this.browser.on('disconnected', () => {
      this.logger.error('Playwright browser disconnected — clearing sessions and restarting');
      this.sessions.clear();
      // Non-blocking restart — if it fails, subsequent skill calls return errors
      void this.launchChromium().then(b => { this.browser = b; }).catch(err => {
        this.logger.error({ err }, 'Browser restart failed');
      });
    });

    this.sweepTimer = setInterval(() => void this.sweep(), this.sweepIntervalMs);
    // Don't let the sweep timer prevent graceful shutdown
    this.sweepTimer.unref();

    this.logger.info({ sessionTtlMs: this.sessionTtlMs }, 'BrowserService started');
  }

  /**
   * Stop the browser service: close all sessions, close the browser, kill Xvfb.
   */
  async stop(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }

    // Close all sessions first, then the browser
    for (const [sessionId, session] of this.sessions.entries()) {
      try {
        await session.close();
      } catch (err) {
        this.logger.error({ err, sessionId }, 'Error closing session during shutdown');
      }
    }
    this.sessions.clear();

    if (this.browser) {
      try {
        await this.browser.close();
      } catch (err) {
        this.logger.error({ err }, 'Error closing browser during shutdown');
      }
      this.browser = null;
    }

    if (this.xvfbProcess) {
      this.xvfbProcess.kill();
      this.xvfbProcess = null;
    }

    this.logger.info('BrowserService stopped');
  }

  /**
   * Get an existing session by ID (refreshing its TTL) or create a new one.
   *
   * - No sessionId → always creates a fresh session.
   * - Valid, non-expired sessionId → refreshes TTL and returns existing session.
   * - Expired sessionId → closes old context, creates a fresh session with a new ID.
   *
   * Returns the session and its (possibly new) sessionId.
   */
  async getOrCreateSession(sessionId: SessionId | undefined): Promise<{ sessionId: SessionId; session: BrowserSession }> {
    if (!this.browser || !this.browser.isConnected()) {
      throw new Error('BrowserService: browser is not running. Call start() first.');
    }

    if (sessionId) {
      const existing = this.sessions.get(sessionId);
      if (existing && !existing.isExpired(this.sessionTtlMs)) {
        // Refresh TTL and return
        existing.lastUsedAt = Date.now();
        return { sessionId, session: existing };
      }
      // Session expired or not found — close it if it exists and create a fresh one
      if (existing) {
        this.logger.debug({ sessionId }, 'Session expired — closing and creating fresh context');
        await existing.close().catch(err => this.logger.error({ err, sessionId }, 'Error closing expired session'));
        this.sessions.delete(sessionId);
      }
    }

    // Create new isolated context + page
    const context = await this.browser.newContext({
      // Viewport that looks like a real laptop browser
      viewport: { width: 1280, height: 720 },
      // Use a common, real browser user agent string
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    });

    // Apply ad blocker to this context if initialized
    const page = await context.newPage();
    if (this.blocker) {
      await this.blocker.enableBlockingInPage(page);
    }
    const newSessionId = randomUUID();
    const session = new BrowserSession(context, page);

    // Crash safety: if the page crashes, invalidate the session so the next
    // skill call starts fresh rather than retrying on a broken page.
    page.on('crash', () => {
      this.logger.error({ sessionId: newSessionId }, 'Page crashed — removing session');
      void session.close().catch(() => {});
      this.sessions.delete(newSessionId);
    });

    this.sessions.set(newSessionId, session);
    this.logger.debug({ sessionId: newSessionId }, 'New browser session created');

    return { sessionId: newSessionId, session };
  }

  /**
   * Explicitly close and remove a session by ID.
   * No-op if the session does not exist.
   */
  async closeSession(sessionId: SessionId): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    await session.close().catch(err => this.logger.error({ err, sessionId }, 'Error closing session'));
    this.sessions.delete(sessionId);
    this.logger.debug({ sessionId }, 'Session closed');
  }

  /**
   * Remove all expired sessions. Called automatically on sweepIntervalMs.
   * Exposed publicly for testing.
   */
  async sweep(): Promise<void> {
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.isExpired(this.sessionTtlMs)) {
        this.logger.debug({ sessionId }, 'Sweeping expired session');
        await session.close().catch(err => this.logger.error({ err, sessionId }, 'Error closing expired session during sweep'));
        this.sessions.delete(sessionId);
      }
    }
  }

  /**
   * Retrieve a session by ID without modifying it.
   * Used by tests to inspect session state. Returns undefined if not found.
   */
  getSession(sessionId: SessionId): BrowserSession | undefined {
    return this.sessions.get(sessionId);
  }

  // --- Private helpers ---

  private async launchChromium(): Promise<Browser> {
    return chromium.launch({
      // headless: false + Xvfb = full browser on a virtual display.
      // This avoids Cloudflare fingerprinting that targets headless mode's
      // missing APIs and renderer differences. On macOS dev machines, no Xvfb
      // is needed — the real display is used directly.
      headless: false,
      args: [
        '--disable-blink-features=AutomationControlled', // removes navigator.webdriver flag
        '--no-sandbox',                                   // required in container environments
        '--disable-dev-shm-usage',                        // prevents /dev/shm OOM in Docker
      ],
    });
  }

  /**
   * Spawn an Xvfb virtual display if running on Linux without an existing DISPLAY.
   * On macOS (darwin), Chromium uses the native windowing system — no Xvfb needed.
   * If DISPLAY is already set (e.g., SSH with X forwarding, CI with Xvfb pre-started),
   * we skip spawning to avoid conflicts.
   */
  private async maybeStartXvfb(): Promise<void> {
    if (process.platform !== 'linux') return;
    if (process.env.DISPLAY) {
      this.logger.debug({ display: process.env.DISPLAY }, 'DISPLAY already set — skipping Xvfb');
      return;
    }

    this.logger.info('Spawning Xvfb virtual display on :99');
    this.xvfbProcess = spawn('Xvfb', [':99', '-screen', '0', '1280x720x24'], {
      stdio: 'ignore',
      detached: false,
    });

    this.xvfbProcess.on('error', (err) => {
      // Xvfb not installed — throw so index.ts can catch and degrade gracefully
      throw new Error(`Xvfb failed to start: ${err.message}. Install with: apt-get install -y xvfb`);
    });

    process.env.DISPLAY = ':99';

    // Give Xvfb a moment to initialize before Chromium tries to connect
    await new Promise(resolve => setTimeout(resolve, 500));
    this.logger.info('Xvfb started on DISPLAY=:99');
  }
}
```

- [ ] **Step 2: Run the BrowserService unit tests — they must pass**

```bash
pnpm test src/browser/browser-service.test.ts
```

Expected: all unit tests PASS. Integration tests skipped (no `RUN_BROWSER_TESTS=1`).

- [ ] **Step 3: Verify TypeScript compiles**

```bash
pnpm typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/browser/browser-service.ts
git commit -m "feat: add BrowserService with warm Playwright browser and session management"
```

---

### Task 6: Add `browserService` to `SkillContext` and `ExecutionLayer`

**Files:**
- Modify: `src/skills/types.ts`
- Modify: `src/skills/execution.ts`

- [ ] **Step 1: Add `browserService?` to `SkillContext` in `src/skills/types.ts`**

Add this import at the top of the import block:

```typescript
// existing imports ...
```

Add to the `SkillContext` interface, after `autonomyService?`:

```typescript
  /** Browser service — available to all skills (not infrastructure-gated).
   *  Provides a warm Playwright Chromium instance with session management.
   *  Skills use this to interact with JS-rendered pages and web forms. */
  browserService?: import('../browser/browser-service.js').BrowserService;
```

- [ ] **Step 2: Add `browserService` to `ExecutionLayer` in `src/skills/execution.ts`**

Add the import at the top:

```typescript
import type { BrowserService } from '../browser/browser-service.js';
```

Add the private field alongside the other private fields:

```typescript
  private browserService?: BrowserService;
```

Add to the `options?` parameter type in the constructor:

```typescript
    browserService?: BrowserService;
```

Add the assignment in the constructor body, after the other `this.X = options?.X` lines:

```typescript
    this.browserService = options?.browserService;
```

Inject it into `ctx` in the `invoke()` method, after the `agentPersona` and `caller` assignments (near line where `ctx` is built — in the block that assigns non-infrastructure properties):

```typescript
    // browserService is available to all skills (not infrastructure-gated).
    // Browser interaction is a read-capable action that doesn't require bus access.
    if (this.browserService) {
      ctx.browserService = this.browserService;
    }
```

- [ ] **Step 3: Run existing tests to verify no regressions**

```bash
pnpm test
```

Expected: all tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/skills/types.ts src/skills/execution.ts
git commit -m "feat: add browserService to SkillContext and ExecutionLayer"
```

---

### Task 7: Wire `BrowserService` into bootstrap and config

**Files:**
- Modify: `src/index.ts`
- Modify: `config/default.yaml`

- [ ] **Step 1: Add the browser config block to `config/default.yaml`**

```yaml
channels:
  cli:
    enabled: true

browser:
  # How long a browser session stays alive after its last action (ms).
  sessionTtlMs: 600000   # 10 minutes
  # How often the session sweep runs to close expired sessions (ms).
  sweepIntervalMs: 120000  # 2 minutes

agents:
  coordinator:
    config_path: agents/coordinator.yaml
```

- [ ] **Step 2: Add BrowserService import to `src/index.ts`**

In the imports section near the other service imports:

```typescript
import { BrowserService } from './browser/browser-service.js';
```

- [ ] **Step 3: Instantiate BrowserService in `src/index.ts`**

Add this block after the `AutonomyService` instantiation (around line 82, after `const autonomyService = ...`) and before the `SkillRegistry` setup:

```typescript
  // Browser service — warm Playwright Chromium instance for the web-browser skill.
  // Optional degradation: if Xvfb is unavailable on Linux, the skill registry still
  // loads but web-browser invocations will fail at ctx.browserService undefined check.
  // This is intentional — Curia should boot even if the browser cannot start.
  let browserService: BrowserService | undefined;
  try {
    browserService = new BrowserService({
      logger,
      sessionTtlMs: (config as Record<string, unknown> & { browser?: { sessionTtlMs?: number } }).browser?.sessionTtlMs ?? 600_000,
      sweepIntervalMs: (config as Record<string, unknown> & { browser?: { sweepIntervalMs?: number } }).browser?.sweepIntervalMs ?? 120_000,
    });
    await browserService.start();
    logger.info('Browser service started');
  } catch (err) {
    logger.warn({ err }, 'Browser service failed to start — web-browser skill will be unavailable');
    browserService = undefined;
  }
```

- [ ] **Step 4: Pass `browserService` to `ExecutionLayer` in `src/index.ts`**

Find the `new ExecutionLayer(...)` call and add `browserService` to its options object:

```typescript
  const executionLayer = new ExecutionLayer(skillRegistry, logger, {
    bus,
    agentRegistry,
    contactService,
    outboundGateway,
    heldMessages,
    schedulerService,
    entityMemory,
    agentPersona,
    nylasCalendarClient,
    entityContextAssembler,
    agentContactId: agentIdentityContactId,
    autonomyService,
    timezone: config.timezone,
    browserService,   // <-- add this
  });
```

- [ ] **Step 5: Add `browserService` to the shutdown handler in `src/index.ts`**

In the `shutdown` async function, before `await pool.end()`:

```typescript
    if (browserService) {
      try {
        await browserService.stop();
      } catch (err) {
        logger.error({ err }, 'Error stopping browser service during shutdown');
      }
    }
```

- [ ] **Step 6: Verify TypeScript compiles**

```bash
pnpm typecheck
```

Expected: no errors. (The `config` cast is temporary — a future task can add `browser` to the config type definition.)

- [ ] **Step 7: Commit**

```bash
git add src/index.ts config/default.yaml
git commit -m "feat: wire BrowserService into bootstrap and graceful shutdown"
```

---

### Task 8: Create `skills/web-browser/skill.json`

**Files:**
- Create: `skills/web-browser/skill.json`

- [ ] **Step 1: Create the manifest**

```json
{
  "name": "web-browser",
  "description": "Control a real web browser to interact with JS-rendered pages, fill forms, navigate multi-step flows, and interact with sites that have no API. Use this instead of web-fetch when a page requires JavaScript, login, or user interaction. Each call performs one action and returns the updated page state. Pass session_id back on subsequent calls to maintain browser context across actions. Actions: navigate (url required), click (selector required), type (selector+text required), select (selector+value required), get_content, screenshot, close_session.",
  "version": "1.0.0",
  "sensitivity": "normal",
  "autonomy_floor": "spot-check",
  "inputs": {
    "action": "string",
    "url": "string?",
    "selector": "string?",
    "text": "string?",
    "value": "string?",
    "session_id": "string?",
    "screenshot": "boolean?"
  },
  "outputs": {
    "content": "string",
    "session_id": "string",
    "url": "string",
    "screenshot_base64": "string?"
  },
  "permissions": ["network:https"],
  "secrets": [],
  "timeout": 30000
}
```

- [ ] **Step 2: Commit**

```bash
git add skills/web-browser/skill.json
git commit -m "feat: add web-browser skill manifest"
```

---

### Task 9: Write failing handler unit tests

**Files:**
- Create: `tests/unit/skills/web-browser.test.ts`

- [ ] **Step 1: Create the test file**

```typescript
// tests/unit/skills/web-browser.test.ts — unit tests for the web-browser skill handler.
//
// BrowserService is fully mocked — no real browser process is started.
// Tests verify action dispatch, input validation, session_id threading, and error paths.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebBrowserHandler } from '../../../skills/web-browser/handler.js';
import type { SkillContext } from '../../../src/skills/types.js';
import type { BrowserService } from '../../../src/browser/browser-service.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

const FAKE_SESSION_ID = 'test-session-123';
const FAKE_URL = 'https://example.com';

// Minimal mock that satisfies what the handler calls on BrowserService
function makeMockBrowserService(): BrowserService {
  const mockSession = {
    page: {
      goto: vi.fn().mockResolvedValue(null),
      click: vi.fn().mockResolvedValue(null),
      fill: vi.fn().mockResolvedValue(null),
      selectOption: vi.fn().mockResolvedValue(null),
      evaluate: vi.fn().mockResolvedValue('cleaned page content'),
      screenshot: vi.fn().mockResolvedValue(Buffer.from('fake-png')),
      url: vi.fn().mockReturnValue(FAKE_URL),
      getByText: vi.fn().mockReturnValue({ click: vi.fn().mockResolvedValue(null), fill: vi.fn().mockResolvedValue(null) }),
      getByRole: vi.fn().mockReturnValue({ click: vi.fn().mockResolvedValue(null), fill: vi.fn().mockResolvedValue(null) }),
      getByLabel: vi.fn().mockReturnValue({ click: vi.fn().mockResolvedValue(null), fill: vi.fn().mockResolvedValue(null) }),
      locator: vi.fn().mockReturnValue({ click: vi.fn().mockResolvedValue(null), fill: vi.fn().mockResolvedValue(null), selectOption: vi.fn().mockResolvedValue(null) }),
    },
    lastUsedAt: Date.now(),
    isExpired: vi.fn().mockReturnValue(false),
    close: vi.fn().mockResolvedValue(undefined),
    context: {} as never,
  };

  return {
    getOrCreateSession: vi.fn().mockResolvedValue({ sessionId: FAKE_SESSION_ID, session: mockSession }),
    closeSession: vi.fn().mockResolvedValue(undefined),
    getSession: vi.fn().mockReturnValue(mockSession),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    sweep: vi.fn().mockResolvedValue(undefined),
  } as unknown as BrowserService;
}

function makeCtx(input: Record<string, unknown>, browserService?: BrowserService): SkillContext {
  return {
    input,
    secret: () => { throw new Error('no secrets needed'); },
    log: logger,
    browserService,
  };
}

describe('WebBrowserHandler', () => {
  let handler: WebBrowserHandler;
  let mockBrowserService: BrowserService;

  beforeEach(() => {
    handler = new WebBrowserHandler();
    mockBrowserService = makeMockBrowserService();
  });

  // --- Input validation ---

  it('returns failure when browserService is not injected', async () => {
    const result = await handler.execute(makeCtx({ action: 'navigate', url: 'https://example.com' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('browserService');
  });

  it('returns failure for missing action', async () => {
    const result = await handler.execute(makeCtx({}, mockBrowserService));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('action');
  });

  it('returns failure for unknown action', async () => {
    const result = await handler.execute(makeCtx({ action: 'teleport' }, mockBrowserService));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('Unknown action');
  });

  it('returns failure for navigate without url', async () => {
    const result = await handler.execute(makeCtx({ action: 'navigate' }, mockBrowserService));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('url');
  });

  it('returns failure for click without selector', async () => {
    const result = await handler.execute(makeCtx({ action: 'click', session_id: FAKE_SESSION_ID }, mockBrowserService));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('selector');
  });

  it('returns failure for type without selector', async () => {
    const result = await handler.execute(makeCtx({ action: 'type', text: 'hello', session_id: FAKE_SESSION_ID }, mockBrowserService));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('selector');
  });

  it('returns failure for type without text', async () => {
    const result = await handler.execute(makeCtx({ action: 'type', selector: 'Email field', session_id: FAKE_SESSION_ID }, mockBrowserService));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('text');
  });

  it('returns failure for select without selector', async () => {
    const result = await handler.execute(makeCtx({ action: 'select', value: 'Option A', session_id: FAKE_SESSION_ID }, mockBrowserService));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('selector');
  });

  it('returns failure for select without value', async () => {
    const result = await handler.execute(makeCtx({ action: 'select', selector: 'Country dropdown', session_id: FAKE_SESSION_ID }, mockBrowserService));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('value');
  });

  // --- Action dispatch ---

  it('navigate: calls getOrCreateSession and page.goto, returns session_id and content', async () => {
    const result = await handler.execute(makeCtx({ action: 'navigate', url: FAKE_URL }, mockBrowserService));
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { session_id: string; content: string; url: string };
      expect(data.session_id).toBe(FAKE_SESSION_ID);
      expect(data.url).toBe(FAKE_URL);
      expect(typeof data.content).toBe('string');
    }
    expect(mockBrowserService.getOrCreateSession).toHaveBeenCalledWith(undefined);
  });

  it('navigate: passes existing session_id to getOrCreateSession', async () => {
    await handler.execute(makeCtx({ action: 'navigate', url: FAKE_URL, session_id: FAKE_SESSION_ID }, mockBrowserService));
    expect(mockBrowserService.getOrCreateSession).toHaveBeenCalledWith(FAKE_SESSION_ID);
  });

  it('click: calls getOrCreateSession and resolves selector', async () => {
    const result = await handler.execute(makeCtx({ action: 'click', selector: 'Sign up button', session_id: FAKE_SESSION_ID }, mockBrowserService));
    expect(result.success).toBe(true);
    expect(mockBrowserService.getOrCreateSession).toHaveBeenCalledWith(FAKE_SESSION_ID);
  });

  it('type: calls fill on the resolved locator', async () => {
    const result = await handler.execute(makeCtx({ action: 'type', selector: 'Email', text: 'test@example.com', session_id: FAKE_SESSION_ID }, mockBrowserService));
    expect(result.success).toBe(true);
  });

  it('get_content: returns page content without navigation', async () => {
    const result = await handler.execute(makeCtx({ action: 'get_content', session_id: FAKE_SESSION_ID }, mockBrowserService));
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { content: string; session_id: string };
      expect(data.session_id).toBe(FAKE_SESSION_ID);
    }
  });

  it('screenshot: returns screenshot_base64 in result', async () => {
    const result = await handler.execute(makeCtx({ action: 'screenshot', session_id: FAKE_SESSION_ID }, mockBrowserService));
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { screenshot_base64: string };
      expect(typeof data.screenshot_base64).toBe('string');
      expect(data.screenshot_base64.length).toBeGreaterThan(0);
    }
  });

  it('screenshot: true on any action also returns screenshot_base64', async () => {
    const result = await handler.execute(makeCtx({ action: 'navigate', url: FAKE_URL, screenshot: true }, mockBrowserService));
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { screenshot_base64?: string };
      expect(data.screenshot_base64).toBeTruthy();
    }
  });

  it('close_session: calls browserService.closeSession with the provided session_id', async () => {
    const result = await handler.execute(makeCtx({ action: 'close_session', session_id: FAKE_SESSION_ID }, mockBrowserService));
    expect(result.success).toBe(true);
    expect(mockBrowserService.closeSession).toHaveBeenCalledWith(FAKE_SESSION_ID);
  });

  it('close_session without session_id returns failure', async () => {
    const result = await handler.execute(makeCtx({ action: 'close_session' }, mockBrowserService));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('session_id');
  });
});
```

- [ ] **Step 2: Run the tests — they must fail** (handler does not exist yet)

```bash
pnpm test tests/unit/skills/web-browser.test.ts
```

Expected: FAIL with `Cannot find module '../../../skills/web-browser/handler.js'`

- [ ] **Step 3: Commit the failing tests**

```bash
git add tests/unit/skills/web-browser.test.ts
git commit -m "test: add failing web-browser handler unit tests"
```

---

### Task 10: Create `skills/web-browser/handler.ts`

**Files:**
- Create: `skills/web-browser/handler.ts`

- [ ] **Step 1: Create the handler**

```typescript
// skills/web-browser/handler.ts — web-browser skill implementation.
//
// Dispatches browser actions to BrowserService, which holds the warm Playwright
// browser. Each action performs one browser operation and returns the current
// page state (cleaned DOM text + optional screenshot).
//
// The LLM drives navigation logic via its tool-use loop. This handler is the
// hands — it executes what the LLM decides, not the reverse.
//
// Security: SSRF is mitigated by Playwright's network stack (no internal IP routing
// surprises), but the permissions system also restricts this skill to network:https.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import type { BrowserAction } from '../../src/browser/types.js';
import type { Page } from 'playwright';

// Maximum cleaned DOM content length before truncation.
// Prevents token blowout on content-heavy pages.
const MAX_CONTENT_LENGTH = 15_000;

export class WebBrowserHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.browserService) {
      return { success: false, error: 'browserService is not available — BrowserService failed to start or is not wired into ExecutionLayer' };
    }

    const { action, url, selector, text, value, session_id, screenshot } = ctx.input as {
      action?: string;
      url?: string;
      selector?: string;
      text?: string;
      value?: string;
      session_id?: string;
      screenshot?: boolean;
    };

    if (!action || typeof action !== 'string') {
      return { success: false, error: 'Missing required input: action (string)' };
    }

    const validActions: BrowserAction[] = ['navigate', 'click', 'type', 'select', 'get_content', 'screenshot', 'close_session'];
    if (!validActions.includes(action as BrowserAction)) {
      return { success: false, error: `Unknown action: "${action}". Valid actions: ${validActions.join(', ')}` };
    }

    // --- close_session: no page interaction needed ---
    if (action === 'close_session') {
      if (!session_id || typeof session_id !== 'string') {
        return { success: false, error: 'close_session requires session_id' };
      }
      await ctx.browserService.closeSession(session_id);
      ctx.log.info({ session_id }, 'Browser session closed');
      return { success: true, data: { content: '', session_id, url: '' } };
    }

    // --- All other actions: acquire session ---
    let sessionId: string;
    let page: Page;
    try {
      const result = await ctx.browserService.getOrCreateSession(session_id ?? undefined);
      sessionId = result.sessionId;
      page = result.session.page as Page;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, session_id }, 'Failed to acquire browser session');
      return { success: false, error: `Failed to acquire browser session: ${message}` };
    }

    ctx.log.info({ action, sessionId, url, selector }, 'Executing browser action');

    try {
      // --- Dispatch action ---
      switch (action as BrowserAction) {
        case 'navigate': {
          if (!url || typeof url !== 'string') {
            return { success: false, error: 'navigate requires url (string)' };
          }
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
          break;
        }

        case 'click': {
          if (!selector || typeof selector !== 'string') {
            return { success: false, error: 'click requires selector (string — describe the element in natural language)' };
          }
          const clickTarget = await resolveLocator(page, selector);
          await clickTarget.click();
          // Brief wait for any triggered navigation or DOM update to settle
          await page.waitForTimeout(500);
          break;
        }

        case 'type': {
          if (!selector || typeof selector !== 'string') {
            return { success: false, error: 'type requires selector (string)' };
          }
          if (text === undefined || text === null || typeof text !== 'string') {
            return { success: false, error: 'type requires text (string)' };
          }
          const typeTarget = await resolveLocator(page, selector);
          await typeTarget.fill(text);
          break;
        }

        case 'select': {
          if (!selector || typeof selector !== 'string') {
            return { success: false, error: 'select requires selector (string)' };
          }
          if (!value || typeof value !== 'string') {
            return { success: false, error: 'select requires value (string)' };
          }
          // Playwright's selectOption works on <select> elements
          await page.locator(selector).selectOption(value);
          break;
        }

        case 'get_content':
          // No navigation — just re-read current state below
          break;

        case 'screenshot': {
          // Screenshot-only action — falls through to screenshot capture below
          break;
        }
      }

      // --- Gather result ---
      const currentUrl = page.url();
      const content = action === 'screenshot'
        ? ''   // screenshot action doesn't need DOM text
        : await getCleanedContent(page);

      const result: Record<string, unknown> = { content, session_id: sessionId, url: currentUrl };

      // Capture screenshot if explicitly requested or if action === 'screenshot'
      if (screenshot || action === 'screenshot') {
        const buf = await page.screenshot({ type: 'png', fullPage: false });
        result.screenshot_base64 = buf.toString('base64');
      }

      return { success: true, data: result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, action, sessionId }, 'Browser action failed');
      return { success: false, error: `Browser action "${action}" failed: ${message}` };
    }
  }
}

/**
 * Resolve a natural language selector to a Playwright locator.
 * Priority order:
 *   1. getByRole (most semantic — "submit button", "Email field")
 *   2. getByLabel (form inputs described by their label)
 *   3. getByText (any visible text match)
 *   4. locator() fallback (CSS/XPath for when natural language fails)
 *
 * Returns the first matching locator strategy that finds at least one element.
 * Falls back to page.locator(selector) if nothing else matches.
 */
async function resolveLocator(page: Page, selector: string): Promise<ReturnType<Page['locator']>> {
  // Try getByRole first — covers buttons, inputs, checkboxes by accessible name
  const roleLocator = page.getByRole('button', { name: selector, exact: false });
  if (await roleLocator.count() > 0) return roleLocator;

  const inputRoleLocator = page.getByRole('textbox', { name: selector, exact: false });
  if (await inputRoleLocator.count() > 0) return inputRoleLocator;

  // Try getByLabel for form inputs described by their label text
  const labelLocator = page.getByLabel(selector, { exact: false });
  if (await labelLocator.count() > 0) return labelLocator;

  // Try getByText for any visible element containing the text
  const textLocator = page.getByText(selector, { exact: false });
  if (await textLocator.count() > 0) return textLocator;

  // CSS/XPath fallback — the LLM can pass a CSS selector directly if natural language fails
  return page.locator(selector);
}

/**
 * Extract cleaned, LLM-friendly text content from the current page.
 * Runs inside the browser via page.evaluate() so we get the rendered DOM,
 * not raw HTML, and can use DOM APIs to strip noise and extract form fields.
 */
async function getCleanedContent(page: Page): Promise<string> {
  const raw = await page.evaluate(() => {
    // Remove noise elements — we want content, not chrome
    const noiseSelectors = ['script', 'style', 'noscript', 'svg', 'iframe', 'template'];
    for (const sel of noiseSelectors) {
      document.querySelectorAll(sel).forEach(el => el.remove());
    }

    // Extract form fields with their labels — the LLM needs to know what
    // fields exist and what they're called to fill them correctly
    const formFields: string[] = [];
    document.querySelectorAll('input, select, textarea').forEach(el => {
      const input = el as HTMLInputElement;
      if (input.type === 'hidden') return;
      const id = input.id;
      const labelEl = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
      const label = labelEl?.textContent?.trim()
        ?? input.getAttribute('placeholder')
        ?? input.getAttribute('name')
        ?? input.type;
      formFields.push(`[${input.type ?? 'field'}: ${label}]`);
    });

    const bodyText = (document.body?.innerText ?? '').trim();
    const formSummary = formFields.length > 0
      ? '\n\n--- Form fields ---\n' + formFields.join('\n')
      : '';

    return bodyText + formSummary;
  });

  // Collapse excess whitespace and truncate
  const cleaned = raw.replace(/\n{3,}/g, '\n\n').trim();
  if (cleaned.length > MAX_CONTENT_LENGTH) {
    return cleaned.slice(0, MAX_CONTENT_LENGTH) + '\n[content truncated]';
  }
  return cleaned;
}
```

- [ ] **Step 2: Run handler unit tests — they must pass**

```bash
pnpm test tests/unit/skills/web-browser.test.ts
```

Expected: all tests PASS.

- [ ] **Step 3: Run full test suite to verify no regressions**

```bash
pnpm test
```

Expected: all tests PASS.

- [ ] **Step 4: Verify TypeScript compiles**

```bash
pnpm typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add skills/web-browser/handler.ts
git commit -m "feat: implement web-browser skill handler with Playwright action dispatcher"
```

---

### Task 11: Add `web-browser` to coordinator pinned skills

**Files:**
- Modify: `agents/coordinator.yaml`

- [ ] **Step 1: Add `web-browser` to `pinned_skills`**

Find the `pinned_skills` block in `agents/coordinator.yaml` and add `web-browser` after `web-fetch`:

```yaml
pinned_skills:
  - entity-context
  - web-fetch
  - web-browser
  - web-search
  - delegate
  - contact-create
```

- [ ] **Step 2: Start Curia and verify the skill loads**

```bash
pnpm dev
```

Look for log lines like:

```
{"level":"info","skillCount":N,"msg":"Skills loaded"}
{"level":"info","agent":"coordinator","skills":["entity-context","web-fetch","web-browser",...],"msg":"Agent tools configured"}
{"level":"info","msg":"Browser service started"}
```

- [ ] **Step 3: Smoke test via CLI**

In the Curia CLI, send:

```
What are the current showtimes at Landmark Cinemas in Waterloo?
```

Curia should use `web-browser` with `navigate` to fetch the page, then read the JS-rendered content. Confirm it reports current showtimes (not May 2026 static HTML dates).

- [ ] **Step 4: Commit**

```bash
git add agents/coordinator.yaml
git commit -m "feat: add web-browser to coordinator pinned skills"
```

---

### Task 12: Write integration test for the full browser flow

**Files:**
- Modify: `src/browser/browser-service.test.ts` (add a `describe` block at the bottom for real-browser integration)

The integration tests already exist in `src/browser/browser-service.test.ts` from Task 4 (the `describe.skipIf(!runBrowserTests)` block). Add one more integration case that tests the full navigate → get_content → close_session flow with a real Chromium instance.

- [ ] **Step 1: Add an end-to-end integration test to `src/browser/browser-service.test.ts`**

Append this block to the file, inside the existing `describe.skipIf(!runBrowserTests)` block:

```typescript
  it('full flow: navigate to a real page and get cleaned content', async () => {
    const { sessionId, session } = await service.getOrCreateSession(undefined);

    // Navigate to a known, stable page
    await session.page.goto('https://example.com', { waitUntil: 'domcontentloaded' });

    // Run the same DOM-cleaning evaluate() that the handler uses
    const content = await session.page.evaluate(() => {
      const noiseSelectors = ['script', 'style', 'noscript', 'svg', 'iframe', 'template'];
      for (const sel of noiseSelectors) {
        document.querySelectorAll(sel).forEach(el => el.remove());
      }
      return (document.body?.innerText ?? '').trim();
    });

    expect(content).toContain('Example Domain');
    expect(content).not.toContain('<script>');

    await service.closeSession(sessionId);
    expect(service.getSession(sessionId)).toBeUndefined();
  });
```

- [ ] **Step 2: Run integration tests with a real browser**

```bash
RUN_BROWSER_TESTS=1 pnpm test src/browser/browser-service.test.ts
```

Expected: all tests PASS including the real-browser integration cases.

- [ ] **Step 3: Verify standard test run (no env var) still skips integration tests**

```bash
pnpm test src/browser/browser-service.test.ts
```

Expected: integration tests are skipped, unit tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/browser/browser-service.test.ts
git commit -m "test: add real-browser integration test for navigate + get_content flow"
```

---

## Acceptance Criteria Checklist

- [ ] `web-browser` skill loads in Curia and appears in coordinator's tool list
- [ ] Landmark Cinemas showtimes test returns live data (not static May 2026 dates)
- [ ] Multi-step flow: `navigate` → `type` → `click` → `get_content` all share a session_id correctly
- [ ] Session expires after TTL — subsequent call with stale session_id starts fresh
- [ ] Browser process crash is recovered without restarting Curia
- [ ] `web-fetch` tests still pass (no regressions)
- [ ] `pnpm test` passes (unit tests only, no `RUN_BROWSER_TESTS`)
- [ ] `pnpm typecheck` passes
