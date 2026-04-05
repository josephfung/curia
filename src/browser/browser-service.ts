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
import { PlaywrightBlocker } from '@ghostery/adblocker-playwright';
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
   * Defaults to chromium.launch(...). Override in tests to inject a mock.
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
    if (this.browser !== null) {
      throw new Error('BrowserService.start() called while already running — call stop() first');
    }

    await this.maybeStartXvfb();
    this.browser = await this.browserFactory();

    // Restart browser automatically on disconnect (e.g., OOM kill)
    this.attachDisconnectedHandler(this.browser);

    // Initialize ad blocker in the background — don't block startup on a network download.
    // Sessions created before initialization completes will run without ad blocking,
    // which is acceptable for correctness. The blocker will be applied to all contexts
    // created after it finishes.
    PlaywrightBlocker.fromPrebuiltAdsAndTracking(fetch).then(blocker => {
      this.blocker = blocker;
      this.logger.info('Ad blocker initialized');
    }).catch((err: unknown) => {
      this.logger.warn({ err }, 'Ad blocker failed to initialize — continuing without ad blocking');
    });

    this.sweepTimer = setInterval(() => void this.sweep(), this.sweepIntervalMs);
    // Don't let the sweep timer prevent graceful shutdown
    this.sweepTimer.unref();

    this.logger.info({ sessionTtlMs: this.sessionTtlMs }, 'BrowserService started');
  }

  /**
   * Attach the 'disconnected' crash-recovery listener to a browser instance.
   * Called on the initial browser and on every restarted browser so that
   * crash recovery continues working after the first restart.
   */
  private attachDisconnectedHandler(browser: import('playwright').Browser): void {
    browser.on('disconnected', () => {
      this.logger.error('Playwright browser disconnected — clearing sessions and restarting');
      this.sessions.clear();
      // Non-blocking restart — if it fails, subsequent skill calls return errors
      void this.browserFactory().then(b => {
        this.browser = b;
        // Reattach the handler on the new browser instance so that a second
        // crash is also recovered. Without this, recovery only works once.
        this.attachDisconnectedHandler(b);
      }).catch(err => {
        this.logger.error({ err }, 'Browser restart failed');
      });
    });
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
      viewport: { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    });

    let page;
    try {
      // Apply ad blocker to this context if initialized
      page = await context.newPage();
      if (this.blocker) {
        try {
          await this.blocker.enableBlockingInPage(page);
        } catch (err) {
          this.logger.warn({ err }, 'Ad blocker failed to attach to page — continuing without ad blocking for this session');
        }
      }
    } catch (err) {
      // If page creation fails, close the context to prevent a resource leak.
      // Without this, the BrowserContext would never be closed since it's not
      // yet in this.sessions and stop() only closes sessions in the map.
      await context.close().catch(closeErr => {
        this.logger.error({ err: closeErr }, 'Failed to close context during page creation cleanup — possible resource leak');
      });
      throw err;
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
    // Snapshot expired entries before any await to prevent concurrent sweep calls
    // from closing the same sessions twice. Delete from the map before awaiting
    // close() so a concurrent getOrCreateSession() can't return a session that's
    // already been closed.
    const expired = [...this.sessions.entries()].filter(([, s]) => s.isExpired(this.sessionTtlMs));
    for (const [sessionId, session] of expired) {
      if (!this.sessions.has(sessionId)) continue; // already closed by a concurrent call
      this.sessions.delete(sessionId);
      this.logger.debug({ sessionId }, 'Sweeping expired session');
      await session.close().catch(err => this.logger.error({ err, sessionId }, 'Error closing expired session during sweep'));
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

    process.env.DISPLAY = ':99';

    // Give Xvfb a moment to initialize. If it fails to start (e.g. not installed,
    // :99 already in use, missing X libraries), reject the promise so start()
    // propagates the error to index.ts for graceful degradation without web-browser.
    //
    // We listen for both 'error' (OS-level spawn failure) and 'close' (process exited
    // abnormally during startup). 'error' alone is not enough — Xvfb can exec
    // successfully and then immediately exit with a non-zero code for runtime failures
    // like a locked display or missing extensions, which only fires 'close', not 'error'.
    await new Promise<void>((resolve, reject) => {
      // Guard against this.xvfbProcess being set to null by stop() while we're
      // still in the 500ms window or when the process dies after a later kill().
      const cleanup = () => {
        if (!this.xvfbProcess) return;
        this.xvfbProcess.off('error', onError);
        this.xvfbProcess.off('close', onClose);
      };
      const onError = (err: Error) => {
        cleanup();
        reject(new Error(`Xvfb failed to start: ${err.message}. Install with: apt-get install -y xvfb`));
      };
      const onClose = (code: number | null) => {
        cleanup();
        reject(new Error(`Xvfb exited during startup (code ${code ?? 'null'}) — is DISPLAY :99 already in use?`));
      };
      this.xvfbProcess!.once('error', onError);
      this.xvfbProcess!.once('close', onClose);
      // If Xvfb is still running after 500ms, consider startup successful.
      // Call cleanup() before resolving so the listeners don't fire later when
      // stop() calls xvfbProcess.kill() — at that point xvfbProcess is set to null
      // synchronously before the async 'close' event fires.
      setTimeout(() => { cleanup(); resolve(); }, 500);
    });
    this.logger.info('Xvfb started on DISPLAY=:99');
  }
}
