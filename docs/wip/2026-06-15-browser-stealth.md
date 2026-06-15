# Browser Bot-Detection Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop anti-bot systems from blocking authorized, user-initiated browser automation by removing the ad-blocker fingerprint, modernizing the browser fingerprint, and adding a persistent profile (with an incognito escape hatch).

**Architecture:** Replace the "one warm `Browser` + isolated context per session" model with a single `launchPersistentContext` (the principal's profile); sessions become pages in that shared context. An opt-in `incognito` flag spins up an ephemeral isolated context off the same browser for Curia's own / throwaway logins. Ad blocking becomes opt-in (off by default, lazy blocklist). Fingerprint is hardened via `playwright-extra` + stealth plugin, real Chrome channel, and context locale/timezone/colorScheme/viewport.

**Tech Stack:** TypeScript (ESM), Playwright, `playwright-extra`, `puppeteer-extra-plugin-stealth`, `@ghostery/adblocker-playwright`, Vitest, Docker (curia-deploy).

**Design doc:** `docs/wip/2026-06-15-browser-stealth-design.md`

**Worktrees:**
- Part A (curia): `worktrees/curia-browser-stealth` (branch `feat/browser-stealth`) — already created.
- Part B (curia-deploy): create a separate worktree at execution time, e.g. `worktrees/curia-deploy-browser-chrome` (branch `feat/browser-chrome-profile`), its own PR.

---

## Part A — curia

### Task 1: Add stealth dependencies

**Files:**
- Modify: `package.json` (root)
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Add the dependencies**

Run (from the worktree root):

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-browser-stealth add playwright-extra puppeteer-extra-plugin-stealth
```

Expected: both added to `dependencies` in `package.json`, `pnpm-lock.yaml` updated.

- [ ] **Step 2: Verify install + no workspace corruption**

Run:

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-browser-stealth status -s pnpm-workspace.yaml
```

Expected: NO changes to `pnpm-workspace.yaml` (if it changed, `git checkout -- pnpm-workspace.yaml` and re-run with `pnpm -C`). If pnpm prints a build-script approval warning for a new package, leave `pnpm-workspace.yaml`'s `allowBuilds` alone unless a genuinely new entry appears — then set it explicitly to `true`/`false`, never placeholder text.

- [ ] **Step 3: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-browser-stealth add package.json pnpm-lock.yaml
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-browser-stealth commit -m "chore: add playwright-extra + stealth plugin (#987)"
```

---

### Task 2: Config typing for new browser fields

**Files:**
- Modify: `src/config.ts` (the `YamlConfig.browser` block, ~lines 134-137)
- Modify: `config/default.yaml` (the `browser:` block, ~lines 60-64)

No behavior to unit-test here (pure type + YAML additions read by the generic loader); verification is `typecheck` in Task 9.

- [ ] **Step 1: Extend the `browser` interface**

In `src/config.ts`, replace the `browser?:` block:

```ts
  browser?: {
    sessionTtlMs?: number;
    sweepIntervalMs?: number;
    /**
     * Persistent browser profile directory. Empty/absent → ${HOME}/.curia/browser-profile.
     * Must be on a mounted volume in production so cookies/session survive restarts.
     */
    profileDir?: string;
    /** Browser channel, e.g. "chrome" for real Chrome. Empty/absent → bundled Chromium. */
    channel?: string;
    /** Context locale (BCP 47). Default "en-US". */
    locale?: string;
  };
```

- [ ] **Step 2: Add the new keys to default.yaml**

In `config/default.yaml`, replace the `browser:` block:

```yaml
browser:
  # How long a browser session stays alive after its last action (ms).
  sessionTtlMs: 600000   # 10 minutes
  # How often the session sweep runs to close expired sessions (ms).
  sweepIntervalMs: 120000  # 2 minutes
  # Persistent profile directory. Empty → ${HOME}/.curia/browser-profile.
  # Mount this on a volume in production so logins survive restarts.
  profileDir: ""
  # Browser channel: "chrome" for real Chrome (must be installed in the image),
  # empty for the bundled Playwright Chromium.
  channel: ""
  # Context locale (BCP 47).
  locale: "en-US"
```

- [ ] **Step 3: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-browser-stealth add src/config.ts config/default.yaml
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-browser-stealth commit -m "feat: add browser profileDir/channel/locale config (#987)"
```

---

### Task 3: BrowserSession — owned-context lifecycle

**Files:**
- Modify: `src/browser/browser-session.ts`
- Test: `src/browser/browser-session.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/browser/browser-session.test.ts` (inside the file, after the existing `describe` block). First add a mock helper near the top (below the existing `makeSession`):

```ts
import { vi } from 'vitest';

/** A session backed by vi.fn() page/context so close() behavior can be asserted. */
function makeClosableSession(opts: { incognito: boolean }) {
  const page = { close: vi.fn().mockResolvedValue(undefined) } as unknown as Page;
  const ownedContext = { close: vi.fn().mockResolvedValue(undefined) } as unknown as BrowserContext;
  const sharedContext = { close: vi.fn().mockResolvedValue(undefined) } as unknown as BrowserContext;
  const session = opts.incognito
    ? new BrowserSession(ownedContext, page, ownedContext)
    : new BrowserSession(sharedContext, page, null);
  return { session, page, ownedContext, sharedContext };
}

describe('BrowserSession close lifecycle', () => {
  it('persistent session closes only its page, not the shared context', async () => {
    const { session, page, sharedContext } = makeClosableSession({ incognito: false });
    await session.close();
    expect((page as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalledOnce();
    expect((sharedContext as unknown as { close: ReturnType<typeof vi.fn> }).close).not.toHaveBeenCalled();
  });

  it('incognito session closes its owned context (which closes the page)', async () => {
    const { session, page, ownedContext } = makeClosableSession({ incognito: true });
    await session.close();
    expect((ownedContext as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalledOnce();
    // We do NOT also call page.close() — context.close() tears the page down.
    expect((page as unknown as { close: ReturnType<typeof vi.fn> }).close).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/browser/browser-session.test.ts | tail -30`
Expected: FAIL — the new `close lifecycle` tests fail because `close()` currently calls `this.context.close()` unconditionally and the constructor ignores a third arg.

- [ ] **Step 3: Implement owned-context lifecycle**

In `src/browser/browser-session.ts`, add the field, constructor param, and new `close()`:

```ts
  /**
   * For INCOGNITO sessions: the ephemeral BrowserContext this session OWNS and must
   * tear down on close. Null for PERSISTENT sessions, whose page lives in the shared
   * persistent profile context — closing that context would kill the whole browser, so
   * a persistent session closes only its page instead. This single switch distinguishes
   * the two session lifecycles (see #987 design).
   */
  private readonly ownedContext: BrowserContext | null;
```

Update the constructor:

```ts
  constructor(context: BrowserContext, page: Page, ownedContext: BrowserContext | null = null) {
    this.context = context;
    this.page = page;
    this.ownedContext = ownedContext;
    this.lastUsedAt = Date.now();
  }
```

Replace `close()`:

```ts
  /**
   * Release this session's browser resources.
   * - Incognito: close the owned ephemeral context (also closes its page).
   * - Persistent: close only the page; the shared profile context stays alive for
   *   other sessions and to keep the profile warm.
   */
  async close(): Promise<void> {
    if (this.ownedContext) {
      await this.ownedContext.close();
    } else {
      await this.page.close();
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/browser/browser-session.test.ts | tail -30`
Expected: PASS (all existing redaction tests + the two new lifecycle tests).

- [ ] **Step 5: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-browser-stealth add src/browser/browser-session.ts src/browser/browser-session.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-browser-stealth commit -m "feat: BrowserSession owned-context close lifecycle (#987)"
```

---

### Task 4: BrowserService — persistent context refactor

This is the core change: drop `chromium.launch()` + per-session `newContext()`, launch a single stealth-wrapped persistent context, and make sessions pages within it. Incognito and lazy-blocker land in Tasks 5 and 6.

**Files:**
- Modify: `src/browser/browser-service.ts`
- Test: `src/browser/browser-service.test.ts`

- [ ] **Step 1: Rework the test mocks**

Replace the `--- Mock Playwright objects ---` section (the three `makeMock*` factories) in `src/browser/browser-service.test.ts` with:

```ts
function makeMockPage() {
  return {
    on: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    goto: vi.fn().mockResolvedValue(null),
    evaluate: vi.fn().mockResolvedValue('page content'),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('fake-png')),
    url: vi.fn().mockReturnValue('https://example.com'),
  };
}

function makeMockBrowser() {
  return {
    isConnected: vi.fn().mockReturnValue(true),
    on: vi.fn(),
    version: vi.fn().mockReturnValue('123.0.0.0'),
    // Set per-test for incognito cases (Task 5).
    newContext: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

// The persistent context is the warm "browser" in the new model. browser() returns
// the underlying Browser so the service can spin up incognito contexts off it.
function makeMockContext(page: ReturnType<typeof makeMockPage>, browser: ReturnType<typeof makeMockBrowser>) {
  return {
    newPage: vi.fn().mockResolvedValue(page),
    close: vi.fn().mockResolvedValue(undefined),
    browser: vi.fn().mockReturnValue(browser),
    on: vi.fn(),
  };
}
```

Update the unit-suite `beforeEach` wiring (the `mockPage/mockContext/mockBrowser` block and the `new BrowserService` call):

```ts
  let mockPage: ReturnType<typeof makeMockPage>;
  let mockBrowser: ReturnType<typeof makeMockBrowser>;
  let mockContext: ReturnType<typeof makeMockContext>;
```

```ts
    mockPage = makeMockPage();
    mockBrowser = makeMockBrowser();
    mockContext = makeMockContext(mockPage, mockBrowser);

    service = new BrowserService({
      logger,
      sessionTtlMs: 1000,
      sweepIntervalMs: 60000,
      // Inject a fake persistent context so no real Playwright process is needed.
      contextFactory: async () => mockContext as never,
    });
    await service.start();
```

- [ ] **Step 2: Update existing unit assertions to the page model**

In `src/browser/browser-service.test.ts`, change the existing behavior assertions:

- "creates a new session when no session_id is provided":
  `expect(mockContext.newPage).toHaveBeenCalledOnce();` (was `mockBrowser.newContext`).
- "reuses an existing session": `expect(mockContext.newPage).toHaveBeenCalledOnce();`.
- "creates a fresh session when the provided session_id has expired":
  `expect(mockContext.newPage).toHaveBeenCalledTimes(2);` and replace the
  `expect(mockContext.close)...` line with `expect(mockPage.close).toHaveBeenCalledOnce();`.
- "closeSession() closes the context and removes the session" → rename intent to page:
  replace `expect(mockContext.close).toHaveBeenCalledOnce();` with
  `expect(mockPage.close).toHaveBeenCalledOnce();`.
- "sweep removes expired sessions": replace `expect(mockContext.close)...` with
  `expect(mockPage.close).toHaveBeenCalledOnce();`.
- "stop() closes all sessions and the browser": replace the two assertions with
  `expect(mockPage.close).toHaveBeenCalledTimes(2);` and
  `expect(mockContext.close).toHaveBeenCalledOnce();`.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/browser/browser-service.test.ts | tail -40`
Expected: FAIL — `contextFactory` is not a recognized option and the service still references `this.browser`.

- [ ] **Step 4: Rewrite BrowserService for the persistent-context model**

In `src/browser/browser-service.ts`:

Replace the imports block (top of file) — drop `chromium` from `'playwright'`, add playwright-extra, stealth, os/path, and the `BrowserContext` type:

```ts
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium as stealthChromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, BrowserContext, BrowserContextOptions } from 'playwright';
import { PlaywrightBlocker } from '@ghostery/adblocker-playwright';
import type { Logger } from '../logger.js';
import { BrowserSession } from './browser-session.js';
import type { SessionId } from './types.js';

// Register the stealth plugin once at module load. It patches the residual automation
// signals (navigator.plugins, window.chrome, WebGL vendor/renderer, permissions.query,
// and the User-Agent) that --disable-blink-features=AutomationControlled alone leaves
// exposed. It applies at the browser level, so it covers both the persistent context and
// any incognito context spun off the same browser.
stealthChromium.use(StealthPlugin());
```

Replace the `BrowserServiceOptions` interface:

```ts
interface BrowserServiceOptions {
  logger: Logger;
  /** Session idle TTL in ms. Default: 600_000 (10 minutes). */
  sessionTtlMs?: number;
  /** How often to sweep expired sessions in ms. Default: 120_000 (2 minutes). */
  sweepIntervalMs?: number;
  /** Persistent profile directory. Empty/absent → ${HOME}/.curia/browser-profile. */
  profileDir?: string;
  /** Browser channel, e.g. 'chrome' for real Chrome. Absent → bundled Chromium. */
  channel?: string;
  /** Context locale (BCP 47). Default 'en-US'. */
  locale?: string;
  /** IANA timezone for the context, aligned to the principal. */
  timezone?: string;
  /**
   * Optional factory to create the persistent BrowserContext.
   * Defaults to launchPersistentContext(...). Override in tests to inject a mock.
   */
  contextFactory?: () => Promise<BrowserContext>;
}
```

Replace the class fields block (the `private logger ... private xvfbProcess` group and the constructor) with:

```ts
  private logger: Logger;
  private sessionTtlMs: number;
  private sweepIntervalMs: number;
  private profileDir: string;
  private channel: string | undefined;
  private locale: string;
  private timezone: string | undefined;
  private contextFactory: () => Promise<BrowserContext>;

  // The persistent context IS the warm browser in this model. Sessions are pages within
  // it (shared cookies/storage = "returning user"); incognito sessions get their own
  // ephemeral context spun off context.browser() (see getOrCreateSession).
  private context: BrowserContext | null = null;
  // Ad blocker is loaded lazily on first opt-in (block_ads:true) and cached. Off by
  // default so login/auth/form-fill flows carry no privacy-extension signal.
  private blocker: PlaywrightBlocker | null = null;
  private blockerPromise: Promise<PlaywrightBlocker> | null = null;
  private sessions: Map<SessionId, BrowserSession> = new Map();
  private sweepTimer: NodeJS.Timeout | null = null;
  private xvfbProcess: ChildProcess | null = null;

  constructor(options: BrowserServiceOptions) {
    this.logger = options.logger.child({ service: 'BrowserService' });
    this.sessionTtlMs = options.sessionTtlMs ?? 600_000;
    this.sweepIntervalMs = options.sweepIntervalMs ?? 120_000;
    this.profileDir = options.profileDir && options.profileDir.length > 0
      ? options.profileDir
      : join(homedir(), '.curia', 'browser-profile');
    this.channel = options.channel && options.channel.length > 0 ? options.channel : undefined;
    this.locale = options.locale && options.locale.length > 0 ? options.locale : 'en-US';
    this.timezone = options.timezone;
    this.contextFactory = options.contextFactory ?? (() => this.launchPersistentContext());
  }
```

Replace `start()`:

```ts
  async start(): Promise<void> {
    if (this.context !== null) {
      throw new Error('BrowserService.start() called while already running — call stop() first');
    }

    await this.maybeStartXvfb();
    this.context = await this.contextFactory();

    // Restart the browser automatically on disconnect (e.g., OOM kill).
    this.attachDisconnectedHandler(this.context);

    this.sweepTimer = setInterval(() => void this.sweep(), this.sweepIntervalMs);
    this.sweepTimer.unref();

    this.logger.info({ sessionTtlMs: this.sessionTtlMs }, 'BrowserService started');
  }
```

Replace `attachDisconnectedHandler(...)`:

```ts
  /**
   * Attach the 'disconnected' crash-recovery listener to the persistent context's
   * underlying browser. On disconnect we clear sessions and relaunch the persistent
   * context, then re-attach so a second crash is also recovered.
   */
  private attachDisconnectedHandler(context: BrowserContext): void {
    const browser = context.browser();
    if (!browser) {
      this.logger.warn('Persistent context has no associated browser — crash recovery disabled');
      return;
    }
    browser.on('disconnected', () => {
      this.logger.error('Playwright browser disconnected — clearing sessions and restarting');
      this.sessions.clear();
      void this.contextFactory().then(ctx => {
        this.context = ctx;
        this.attachDisconnectedHandler(ctx);
      }).catch(err => {
        this.logger.error({ err }, 'Browser restart failed');
      });
    });
  }
```

Replace `stop()` (the body that closes sessions/browser/xvfb) — change the browser close to context close:

```ts
  async stop(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }

    for (const [sessionId, session] of this.sessions.entries()) {
      try {
        await session.close();
      } catch (err) {
        this.logger.error({ err, sessionId }, 'Error closing session during shutdown');
      }
    }
    this.sessions.clear();

    if (this.context) {
      try {
        await this.context.close();
      } catch (err) {
        this.logger.error({ err }, 'Error closing browser context during shutdown');
      }
      this.context = null;
    }

    if (this.xvfbProcess) {
      this.xvfbProcess.kill();
      this.xvfbProcess = null;
    }

    this.logger.info('BrowserService stopped');
  }
```

Replace `getOrCreateSession(...)` (persistent-only for now; incognito/blockAds params added but incognito branch and blocker added in Tasks 5/6 — include the full version here so the file is consistent):

```ts
  async getOrCreateSession(
    sessionId: SessionId | undefined,
    opts: { incognito?: boolean; blockAds?: boolean } = {},
  ): Promise<{ sessionId: SessionId; session: BrowserSession }> {
    const browser = this.context?.browser();
    if (!this.context || !browser || !browser.isConnected()) {
      throw new Error('BrowserService: browser is not running. Call start() first.');
    }

    if (sessionId) {
      const existing = this.sessions.get(sessionId);
      if (existing && !existing.isExpired(this.sessionTtlMs)) {
        existing.lastUsedAt = Date.now();
        return { sessionId, session: existing };
      }
      if (existing) {
        this.logger.debug({ sessionId }, 'Session expired — closing and creating fresh session');
        await existing.close().catch(err => this.logger.error({ err, sessionId }, 'Error closing expired session'));
        this.sessions.delete(sessionId);
      }
    }

    // Incognito → fresh isolated context off the same browser, never touching the
    // principal's persistent profile. Persistent (default) → a page in the shared profile.
    let ownedContext: BrowserContext | null = null;
    let page;
    try {
      if (opts.incognito) {
        ownedContext = await browser.newContext(this.buildContextOptions());
        page = await ownedContext.newPage();
      } else {
        page = await this.context.newPage();
      }
      if (opts.blockAds) {
        const blocker = await this.getBlocker();
        if (blocker) {
          try {
            await blocker.enableBlockingInPage(page);
          } catch (err) {
            this.logger.warn({ err }, 'Ad blocker failed to attach to page — continuing without ad blocking for this session');
          }
        }
      }
    } catch (err) {
      // Clean up a half-created session to prevent a leak (it's not yet in the map).
      if (ownedContext) {
        await ownedContext.close().catch(closeErr => {
          this.logger.error({ err: closeErr }, 'Failed to close incognito context during cleanup — possible resource leak');
        });
      } else if (page) {
        await page.close().catch(() => {});
      }
      throw err;
    }

    const newSessionId = randomUUID();
    const session = new BrowserSession(ownedContext ?? this.context, page, ownedContext);

    page.on('crash', () => {
      this.logger.error({ sessionId: newSessionId }, 'Page crashed — removing session');
      void session.close().catch(() => {});
      this.sessions.delete(newSessionId);
    });

    this.sessions.set(newSessionId, session);
    this.logger.debug(
      { sessionId: newSessionId, incognito: opts.incognito === true, blockAds: opts.blockAds === true },
      'New browser session created',
    );

    return { sessionId: newSessionId, session };
  }
```

Add the private helpers (`buildContextOptions`, `getBlocker`, `launchPersistentContext`, `logChannel`) in the `--- Private helpers ---` section, REPLACING the old `launchChromium()`:

```ts
  /**
   * Fingerprint/context options shared by the persistent context and any incognito
   * context. We deliberately DO NOT set userAgent — with the real Chrome channel and the
   * stealth plugin's UA-override evasion the genuine current UA is sent, so it can never
   * go stale (the old hardcoded Chrome/122 was a bot tell). timezoneId is set only when a
   * timezone is configured, aligning the context with the principal.
   */
  private buildContextOptions(): BrowserContextOptions {
    return {
      viewport: { width: 1280, height: 720 },
      locale: this.locale,
      colorScheme: 'light',
      ...(this.timezone ? { timezoneId: this.timezone } : {}),
    };
  }

  /**
   * Lazily fetch the Ghostery blocklist on first opt-in (block_ads:true) and cache it.
   * Off by default, so most sessions never pay this cost. A fetch failure logs and returns
   * null (blocking is best-effort) and clears the cached promise so a later opt-in retries.
   */
  private async getBlocker(): Promise<PlaywrightBlocker | null> {
    if (this.blocker) return this.blocker;
    try {
      this.blockerPromise ??= PlaywrightBlocker.fromPrebuiltAdsAndTracking(fetch);
      this.blocker = await this.blockerPromise;
      this.logger.info('Ad blocker initialized (first opt-in)');
      return this.blocker;
    } catch (err) {
      this.logger.warn({ err }, 'Ad blocker failed to initialize — continuing without ad blocking');
      this.blockerPromise = null;
      return null;
    }
  }

  /**
   * Launch the single persistent browser context (the principal's profile). Tries the
   * configured channel (e.g. real Chrome) first and falls back to bundled Chromium if it
   * isn't installed, so the skill degrades instead of failing to boot. Cast through unknown:
   * playwright-extra returns a playwright-core BrowserContext, structurally identical to the
   * 'playwright' BrowserContext we type against.
   */
  private async launchPersistentContext(): Promise<BrowserContext> {
    const baseOptions = {
      headless: false,
      args: [
        '--disable-blink-features=AutomationControlled', // removes navigator.webdriver flag
        '--no-sandbox',                                   // required in container environments
        '--disable-dev-shm-usage',                        // prevents /dev/shm OOM in Docker
      ],
      ...this.buildContextOptions(),
    };

    try {
      const context = await stealthChromium.launchPersistentContext(
        this.profileDir,
        this.channel ? { ...baseOptions, channel: this.channel } : baseOptions,
      ) as unknown as BrowserContext;
      this.logChannel(context, this.channel);
      return context;
    } catch (err) {
      if (!this.channel) throw err; // no channel to fall back from — a genuine launch failure
      this.logger.warn({ err, channel: this.channel }, 'Failed to launch with channel — falling back to bundled Chromium');
      const context = await stealthChromium.launchPersistentContext(
        this.profileDir,
        baseOptions,
      ) as unknown as BrowserContext;
      this.logChannel(context, undefined);
      return context;
    }
  }

  /** Log the resolved channel + real browser version for observability (UA traceability). */
  private logChannel(context: BrowserContext, channel: string | undefined): void {
    const version = context.browser()?.version();
    this.logger.info({ channel: channel ?? 'chromium', version, profileDir: this.profileDir }, 'Persistent browser context launched');
  }
```

Also update the file-header comment block: the line "Each session gets its own isolated BrowserContext (separate cookies/storage)" should be replaced with a note that sessions are pages in one shared persistent profile context (returning-user state) and incognito sessions get an isolated ephemeral context. Keep the SCALABILITY @TODO block.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/browser/browser-service.test.ts | tail -40`
Expected: PASS for the unit suite (the `clearStaleX11Lock` / `isXServerBinary` suites are untouched). Integration suite stays skipped (no `RUN_BROWSER_TESTS`).

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-browser-stealth add src/browser/browser-service.ts src/browser/browser-service.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-browser-stealth commit -m "feat: persistent-context browser model with fingerprint hardening (#987)"
```

---

### Task 5: Incognito session test coverage

The incognito branch was implemented in Task 4; this task locks it with tests.

**Files:**
- Test: `src/browser/browser-service.test.ts`

- [ ] **Step 1: Write the failing test**

Add inside the `describe('BrowserService (unit — mocked browser)', ...)` block:

```ts
  it('incognito session uses a fresh isolated context, not the persistent profile', async () => {
    const incognitoPage = makeMockPage();
    const incognitoContext = {
      newPage: vi.fn().mockResolvedValue(incognitoPage),
      close: vi.fn().mockResolvedValue(undefined),
      browser: vi.fn().mockReturnValue(mockBrowser),
      on: vi.fn(),
    };
    mockBrowser.newContext.mockResolvedValue(incognitoContext as never);

    const { sessionId } = await service.getOrCreateSession(undefined, { incognito: true });

    // Came from a fresh context off the browser, NOT the persistent profile.
    expect(mockBrowser.newContext).toHaveBeenCalledOnce();
    expect(mockContext.newPage).not.toHaveBeenCalled();

    // Closing the session tears down the OWNED context (isolation), not just a page.
    await service.closeSession(sessionId);
    expect(incognitoContext.close).toHaveBeenCalledOnce();
  });
```

- [ ] **Step 2: Run to verify it passes**

Run: `npx vitest run src/browser/browser-service.test.ts -t incognito | tail -20`
Expected: PASS (implementation already exists from Task 4).

- [ ] **Step 3: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-browser-stealth add src/browser/browser-service.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-browser-stealth commit -m "test: incognito session isolation (#987)"
```

---

### Task 6: Opt-in ad blocker test coverage

The blocker is now opt-in + lazy (implemented in Task 4). This task adds tests and the adblocker module mock.

**Files:**
- Test: `src/browser/browser-service.test.ts`

- [ ] **Step 1: Add the hoisted adblocker mock**

Near the top of `src/browser/browser-service.test.ts` (after the imports), add:

```ts
// Mock the Ghostery blocker so no real blocklist is fetched in unit tests. A stable
// fakeBlocker lets us assert enableBlockingInPage call counts; fromPrebuilt lets us
// assert the lazy fetch happened (or didn't).
const { fakeBlocker, fromPrebuilt } = vi.hoisted(() => {
  const fb = { enableBlockingInPage: vi.fn().mockResolvedValue(undefined) };
  return { fakeBlocker: fb, fromPrebuilt: vi.fn().mockResolvedValue(fb) };
});
vi.mock('@ghostery/adblocker-playwright', () => ({
  PlaywrightBlocker: { fromPrebuiltAdsAndTracking: fromPrebuilt },
}));
```

In the unit suite `beforeEach`, after `await service.start();`, clear the spies so each test starts clean:

```ts
    fromPrebuilt.mockClear();
    fakeBlocker.enableBlockingInPage.mockClear();
```

- [ ] **Step 2: Write the failing tests**

Add inside the unit `describe` block:

```ts
  it('does not fetch or attach the blocker by default (off for login/form flows)', async () => {
    await service.getOrCreateSession(undefined);
    expect(fromPrebuilt).not.toHaveBeenCalled();
    expect(fakeBlocker.enableBlockingInPage).not.toHaveBeenCalled();
  });

  it('attaches the blocker only when block_ads is true, fetching the list lazily once', async () => {
    await service.getOrCreateSession(undefined, { blockAds: true });
    await service.getOrCreateSession(undefined, { blockAds: true });
    // Blocklist fetched once and cached across opt-ins.
    expect(fromPrebuilt).toHaveBeenCalledOnce();
    // Attached per opt-in session.
    expect(fakeBlocker.enableBlockingInPage).toHaveBeenCalledTimes(2);
  });
```

- [ ] **Step 3: Run to verify they pass**

Run: `npx vitest run src/browser/browser-service.test.ts -t "blocker" | tail -20`
Expected: PASS (implementation from Task 4).

- [ ] **Step 4: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-browser-stealth add src/browser/browser-service.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-browser-stealth commit -m "test: opt-in lazy ad blocker (#987)"
```

---

### Task 7: Wire config into index.ts

Fixes the long-standing dead cast (#204) and passes the new fields + timezone.

**Files:**
- Modify: `src/index.ts` (~lines 762-770)

No new behavior test (covered by typecheck + startup); the browser config path has no unit harness.

- [ ] **Step 1: Replace the dead cast with typed config**

In `src/index.ts`, replace the `const browserConfig = (config as unknown as ...)` line and the `new BrowserService({...})` call with:

```ts
    const browserConfig = yamlConfig.browser;
    browserService = new BrowserService({
      logger,
      sessionTtlMs: browserConfig?.sessionTtlMs ?? 600_000,
      sweepIntervalMs: browserConfig?.sweepIntervalMs ?? 120_000,
      profileDir: browserConfig?.profileDir,
      channel: browserConfig?.channel,
      locale: browserConfig?.locale,
      // Align the browser timezone with the principal's configured timezone.
      timezone: config.timezone,
    });
```

(Delete the now-obsolete TODO(#192)/#204 comment block above it.)

- [ ] **Step 2: Typecheck**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-browser-stealth run typecheck | tail -20`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-browser-stealth add src/index.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-browser-stealth commit -m "feat: wire browser profileDir/channel/locale/timezone config (#987, fixes #204)"
```

---

### Task 8: web-browser skill — block_ads + incognito inputs

**Files:**
- Modify: `skills/web-browser/handler.ts`
- Modify: `skills/web-browser/skill.json`
- Test: `skills/web-browser/handler.test.ts`

- [ ] **Step 1: Write the failing test**

Inspect `skills/web-browser/handler.test.ts` for the existing mock-context shape (it stubs `ctx.browserService.getOrCreateSession`). Add a test asserting the handler forwards the two flags. Use the existing test's harness/helpers; the assertion is:

```ts
  it('forwards block_ads and incognito to getOrCreateSession', async () => {
    const getOrCreateSession = vi.fn().mockResolvedValue({
      sessionId: 'sess-1',
      session: { page: makeFakePage(), registerInjectedSecret: vi.fn(), redactInjectedSecrets: (s: string) => s },
    });
    const ctx = makeCtx({ browserService: { getOrCreateSession, closeSession: vi.fn() } }, {
      action: 'navigate', url: 'https://example.com', block_ads: true, incognito: true,
    });

    await new WebBrowserHandler().execute(ctx);

    expect(getOrCreateSession).toHaveBeenCalledWith(undefined, { incognito: true, blockAds: true });
  });
```

(Adapt `makeCtx` / `makeFakePage` to the existing helpers in that test file. If the file builds `ctx` inline, mirror that style — the key assertion is the `getOrCreateSession` call args.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run skills/web-browser/handler.test.ts -t "forwards block_ads" | tail -20`
Expected: FAIL — handler calls `getOrCreateSession(session_id ?? undefined)` with no options object.

- [ ] **Step 3: Implement flag parsing + forwarding**

In `skills/web-browser/handler.ts`, add `block_ads` and `incognito` to the destructured input and its type:

```ts
    const { action, url, selector, text, value, secret_ref, session_id, screenshot, block_ads, incognito } = ctx.input as {
      action?: string;
      url?: string;
      selector?: string;
      text?: string;
      value?: string;
      secret_ref?: string;
      session_id?: string;
      screenshot?: boolean;
      // block_ads (#987): opt in to ad/tracker blocking. Off by default — login,
      // authenticated, and form-fill flows must not carry a privacy-extension signal.
      block_ads?: boolean;
      // incognito (#987): run this session in a fresh, isolated context instead of the
      // principal's persistent profile. For Curia's own logins or throwaway flows.
      incognito?: boolean;
    };
```

Update the `getOrCreateSession` call in the session-acquisition block:

```ts
      const result = await ctx.browserService.getOrCreateSession(session_id ?? undefined, {
        incognito: incognito === true,
        blockAds: block_ads === true,
      });
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run skills/web-browser/handler.test.ts | tail -30`
Expected: PASS (new test + all existing).

- [ ] **Step 5: Update skill.json**

In `skills/web-browser/skill.json`:
- Bump `"version"` from `"1.1.0"` to `"1.2.0"` (new inputs/capability → minor).
- Add to `inputs`: `"block_ads": "boolean?"` and `"incognito": "boolean?"`.
- Update `description` — append before the final period:

> ` Set block_ads:true ONLY for plain content browsing — never for login, authenticated, or form-fill flows (sites flag the ad blocker as a privacy extension). Set incognito:true to run in a throwaway, isolated session (e.g. logging in as Curia itself) instead of the principal's persistent profile; omit it for the principal's own accounts so sessions persist.`

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-browser-stealth add skills/web-browser/handler.ts skills/web-browser/handler.test.ts skills/web-browser/skill.json
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-browser-stealth commit -m "feat: block_ads + incognito inputs on web-browser skill (#987)"
```

---

### Task 9: CHANGELOG + verification

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add CHANGELOG entries**

Under `## [Unreleased]`, add (create the section headers if absent):

```markdown
### Added
- **Browser incognito sessions** — `incognito:true` on `web-browser` runs in a throwaway isolated context, keeping Curia's own logins out of the principal's profile. (#987)
- **Persistent browser profile** — the browser now uses a persistent context on a mounted volume, so logins/cookies survive restarts. (#987)

### Changed
- **`web-browser` ad blocking is now opt-in** (`block_ads:true`) and off by default, so login/auth/form-fill flows no longer trip "privacy extension" bot detection (e.g. x.com). (#987)
- **Browser fingerprint hardened** — real Chrome channel where available, current (non-stale) UA via `playwright-extra` + stealth, plus context locale/timezone/colorScheme. (#987)

### Fixed
- **Browser YAML config now takes effect** — `browser.*` settings were read through a dead cast and silently ignored. (#987, #204)
```

- [ ] **Step 2: Full typecheck + test suite**

Run:

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-browser-stealth run typecheck | tail -20
```

Expected: no errors.

```bash
npx vitest run src/browser/ skills/web-browser/ | tail -40
```

Expected: all PASS.

- [ ] **Step 3: Optional real-browser smoke (if Chromium available locally)**

Run: `RUN_BROWSER_TESTS=1 npx vitest run src/browser/browser-service.test.ts | tail -30`
Expected: the integration suite passes (creates a persistent context in a temp profile, navigates example.com). If it fails only due to a missing local display/browser, note it and rely on CI.

- [ ] **Step 4: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-browser-stealth add CHANGELOG.md
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-browser-stealth commit -m "docs: changelog for browser hardening (#987)"
```

---

### Task 10: Persistence integration test (gated)

**Files:**
- Test: `src/browser/browser-service.test.ts` (integration block)

- [ ] **Step 1: Add a restart-persistence integration test**

Inside the `describe.skipIf(!runBrowserTests)('BrowserService (integration — real Chromium)', ...)` block, add a test that uses a fixed temp profile dir across two service instances:

```ts
  it('persists cookies across a service restart (persistent profile)', async () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'curia-profile-'));
    try {
      const s1 = new BrowserService({ logger, sessionTtlMs: 30000, sweepIntervalMs: 60000, profileDir });
      await s1.start();
      const { session } = await s1.getOrCreateSession(undefined);
      await session.page.goto('https://example.com');
      await session.page.evaluate(() => { document.cookie = 'curia_test=1; path=/'; });
      await s1.stop();

      const s2 = new BrowserService({ logger, sessionTtlMs: 30000, sweepIntervalMs: 60000, profileDir });
      await s2.start();
      const { session: session2 } = await s2.getOrCreateSession(undefined);
      await session2.page.goto('https://example.com');
      const cookie = await session2.page.evaluate(() => document.cookie);
      expect(cookie).toContain('curia_test=1');
      await s2.stop();
    } finally {
      rmSync(profileDir, { recursive: true, force: true });
    }
  });
```

(`mkdtempSync`, `tmpdir`, `join`, `rmSync` are already imported at the top of the test file.)

- [ ] **Step 2: Run it (gated)**

Run: `RUN_BROWSER_TESTS=1 npx vitest run src/browser/browser-service.test.ts -t "persists cookies" | tail -30`
Expected: PASS (a returning visit to example.com still has the cookie set before restart). If no local browser/display, document that this runs in CI / manual verification.

- [ ] **Step 3: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-browser-stealth add src/browser/browser-service.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-browser-stealth commit -m "test: persistent-profile survives restart (#987)"
```

---

## Part B — curia-deploy (separate worktree + PR)

> Execute in a fresh curia-deploy worktree (e.g. `worktrees/curia-deploy-browser-chrome`, branch `feat/browser-chrome-profile`). Pull main first; symlink any gitignored files; `pnpm -C` for installs. Separate PR.

### Task B1: Install real Chrome in the image

**Files:**
- Modify: `deploy/compose/Dockerfile.curia` (~lines 100-101)

- [ ] **Step 1: Add the Chrome channel install**

After the existing `playwright install --with-deps chromium` block, add a line so the real Chrome channel resolves for `channel: 'chrome'`:

```dockerfile
# Install real Google Chrome (the "chrome" channel) for fingerprint hardening (#987).
# --with-deps on the chromium install above already pulled the shared system libs, so
# this just lays down Google Chrome stable. Sites fingerprint bundled Chromium; real
# Chrome presents a genuine, current UA + feature set.
RUN pnpm exec playwright install chrome
```

- [ ] **Step 2: Build the image locally to confirm Chrome installs**

Run a build (from the build context root that holds `curia/` and `curia-deploy/`):

```bash
docker build -f curia-deploy/deploy/compose/Dockerfile.curia -t curia-test .
```

Expected: build succeeds; `playwright install chrome` completes.

- [ ] **Step 3: Commit**

```bash
git -C <curia-deploy-worktree> add deploy/compose/Dockerfile.curia
git -C <curia-deploy-worktree> commit -m "feat: install real Chrome channel for browser hardening (curia#987)"
```

### Task B2: Persistent profile volume

**Files:**
- Modify: `deploy/compose/Dockerfile.curia` (pre-create the dir, near the google_workspace_mcp block ~line 167)
- Modify: `deploy/compose/compose.production.yaml` (volumes + the named volume declaration)

- [ ] **Step 1: Pre-create + chown the profile dir in the Dockerfile**

After the `mkdir -p /home/curia/.google_workspace_mcp` block, add:

```dockerfile
# Pre-create the persistent browser profile dir (#987) owned by curia. The web-browser
# skill's BrowserService launches a persistent context here so cookies/sessions survive
# restarts. Path is $HOME/.curia/browser-profile; HOME=/home/curia (set below). On a fresh
# named volume Docker copy-up seeds this curia ownership so first-run writes succeed.
RUN mkdir -p /home/curia/.curia/browser-profile \
 && chown -R curia:curia /home/curia/.curia
```

- [ ] **Step 2: Mount a named volume at the profile path**

In `compose.production.yaml`, under the curia service `volumes:` (alongside `google-workspace-tokens`), add:

```yaml
      # Persistent browser profile (#987) — cookies/localStorage/history for the
      # web-browser skill, so logins survive restarts. Path matches HOME=/home/curia
      # and browser.profileDir's default (${HOME}/.curia/browser-profile).
      - curia-browser-profile:/home/curia/.curia/browser-profile
```

And under the top-level `volumes:` block, declare it:

```yaml
  # Persistent browser profile for the web-browser skill (#987).
  curia-browser-profile:
```

- [ ] **Step 3: Commit**

```bash
git -C <curia-deploy-worktree> add deploy/compose/Dockerfile.curia deploy/compose/compose.production.yaml
git -C <curia-deploy-worktree> commit -m "feat: persistent browser-profile volume (curia#987)"
```

### Task B3: Enable the Chrome channel in deploy config

**Files:**
- Modify: the instance config layer (`config/local.yaml` provided at deploy time, or the equivalent curia-deploy config mechanism — confirm during the worktree setup)

- [ ] **Step 1: Set the channel**

Add to the deploy-time `local.yaml` (merged over `config/default.yaml`):

```yaml
browser:
  channel: chrome
  # profileDir left as default → ${HOME}/.curia/browser-profile (matches the volume mount).
```

- [ ] **Step 2: Commit** (in whatever file the instance owns; if it's a gitignored secret-layer file, document the change in the deploy runbook instead).

---

## Manual re-test checklist (post-deploy, in the PR description)

Per the issue's acceptance criteria — verify by hand after deploy:

- [ ] x.com login page **renders and accepts credentials** with `block_ads` off (no "privacy related extensions" error).
- [ ] OpenTable reservation flow reaches and submits its form.
- [ ] A personality-test form fill reaches and submits.
- [ ] Log into a site once, `docker restart` the curia container, revisit — still authenticated (persistent profile works).
- [ ] An `incognito:true` session does NOT see cookies set in a prior persistent session.

---

## Self-review notes

- **Spec coverage:** ad-blocker opt-in (T4/T6/T8), fingerprint UA/channel/locale/tz/colorScheme/viewport (T4), stealth (T1/T4), persistent profile (T4/T10/B2), incognito identity scope (T3/T4/T5/T8), deploy chrome+volume (B1/B2/B3), config wiring + #204 fix (T2/T7). All design sections map to a task.
- **Type consistency:** `getOrCreateSession(sessionId, { incognito?, blockAds? })`, `BrowserSession(context, page, ownedContext?)`, `buildContextOptions(): BrowserContextOptions`, `getBlocker()`, `launchPersistentContext()` are used consistently across tasks and the handler.
- **Known cast:** `launchPersistentContext(...) as unknown as BrowserContext` bridges playwright-extra (playwright-core) and the `'playwright'` types; commented at the call site.
