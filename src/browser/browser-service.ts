// src/browser/browser-service.ts — manages a warm Playwright browser and session map.
//
// A single PERSISTENT browser context is launched at startup (the principal's profile)
// and kept warm. Sessions are PAGES within that one shared context, so they share
// cookies/storage/cache — the site sees a "returning user", not a fresh anonymous
// browser each time. An opt-in incognito session instead gets its own isolated ephemeral
// context spun off the same browser (never touching the persistent profile).
// Sessions expire after sessionTtlMs of inactivity and are swept on an interval.
//
// Where Chrome runs (#2541):
//
// - Browser container (cdpEndpoint set, BROWSER_CDP_URL in the shipped docker-compose.yml):
//   Chrome, Xvfb and the profile live in the curia-browser image's own container, and this
//   service attaches over CDP. Chrome then runs without Curia's secrets or database access,
//   and a Chrome crash cannot take Curia down. The service boots even when the container is
//   down and keeps reconnecting, so health reports the browser as failed until it is back.
// - In-process (no cdpEndpoint): Chrome is launched here, as before. Running from source and
//   images built on the core image (which has no browser) still use it.
//
// SCALABILITY @TODO: one browser serves every session. To scale to higher concurrency, run
// N browser containers and round-robin sessions across them. Only this file needs to
// change: the handler, session model, and ToolContext interface are unaffected.

import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { lookup as dnsLookup } from 'node:dns/promises';
import { existsSync, readFileSync, rmSync, lstatSync, readlinkSync } from 'node:fs';
import { isIP } from 'node:net';
import { homedir, hostname as osHostname } from 'node:os';
import { join } from 'node:path';
// Patchright is a drop-in Playwright fork that patches the protocol-level leaks the old
// stealth plugin couldn't reach — most importantly the CDP `Runtime.enable` /
// console / exec-context leaks detection vendors key on, plus Playwright's own header
// signatures. We keep the real-Chrome channel + persistent-context model unchanged; only
// the launcher changes. The rest of the file types against the 'playwright' BrowserContext
// (structurally identical), hence the existing `as unknown as BrowserContext` casts. (#1053)
import { chromium } from 'patchright';
import type { Browser, BrowserContext, BrowserContextOptions, Page } from 'playwright';
import { PlaywrightBlocker } from '@ghostery/adblocker-playwright';
import type { Logger } from '../logger.js';
import { BrowserSession } from './browser-session.js';
import type { SessionId } from './types.js';
import { parseProxyConfig, type ProxyConfig } from './proxy-config.js';

// Xvfb screen and browser window geometry. The window must fit inside the screen: a
// window bigger than its screen is a fingerprint inconsistency no real device shows.
// The window is kept short of full-screen so screenshots stay a moderate size. (#2221)
export const SCREEN_SIZE = { width: 1920, height: 1080 } as const;
export const WINDOW_SIZE = { width: 1440, height: 900 } as const;

/** How long the CDP connection itself may take before it counts as failed. */
const CDP_CONNECT_TIMEOUT_MS = 10_000;
/** How long a whole attach (connect plus tidying old tabs) may take. A wedged or hostile
 *  container must not hold up Curia's boot or stall reconnects. */
const CDP_ATTACH_DEADLINE_MS = 20_000;
/** Reconnect backoff to the browser container: 1s doubling to this cap. */
const CDP_RECONNECT_MAX_DELAY_MS = 30_000;
/** While the container stays down, a failed attempt is logged at warn this often (~10 min at the cap). */
const CDP_RECONNECT_WARN_EVERY = 20;

interface BrowserServiceOptions {
  logger: Logger;
  /** Session idle TTL in ms. Default: 1_800_000 (30 minutes) — long enough that a multi-page
   *  form (e.g. a 60-question survey) doesn't get its session evicted between agent turns,
   *  which would orphan every element ref the agent still holds. */
  sessionTtlMs?: number;
  /** How often to sweep expired sessions in ms. Default: 120_000 (2 minutes). */
  sweepIntervalMs?: number;
  /** Absolute-age cap for keep-warm (pinned) sessions in ms. A pinned session is exempt from
   *  the idle TTL but still evicted once older than this since creation, so a task that never
   *  releases its session can't leak a browser tab forever. Default: 7_200_000 (2 hours). */
  keepWarmMaxAgeMs?: number;
  /** Persistent profile directory. Empty/absent → ${HOME}/.curia/browser-profile. */
  profileDir?: string;
  /** Browser channel, e.g. 'chrome' for real Chrome. Absent → bundled Chromium. */
  channel?: string;
  /**
   * Optional egress proxy for browser traffic (e.g. a residential home-network exit).
   * Full URL or bare host:port. Absent/empty → direct egress. See parseProxyConfig.
   */
  proxy?: string;
  /** Context locale (BCP 47). Default 'en-US'. */
  locale?: string;
  /** Ordered navigator.languages / Accept-Language list. `locale` is always first. */
  languages?: string[];
  /** Longest the web-browser skill waits for a page to finish redirecting before reading
   *  it, in ms (#2244). Default 35_000: Air Canada's sign-in chain takes ~28s. */
  settleCapMs?: number;
  /** IANA timezone for the context, aligned to the principal. */
  timezone?: string;
  /**
   * DevTools endpoint of a browser container to attach to (e.g. http://browser:9222), from
   * BROWSER_CDP_URL. Absent → launch Chrome in-process. When set, the profile, locale,
   * window and proxy are the container's: profileDir, channel, locale and languages are
   * ignored, and a proxy is refused (see the constructor). (#2541)
   */
  cdpEndpoint?: string;
  /**
   * Optional factory to create the persistent BrowserContext.
   * Defaults to launchPersistentContext(...), or to attaching to cdpEndpoint when that is
   * set. Override in tests to inject a mock.
   */
  contextFactory?: () => Promise<BrowserContext>;
}

export class BrowserService {
  private logger: Logger;
  private sessionTtlMs: number;
  private sweepIntervalMs: number;
  private keepWarmMaxAgeMs: number;
  private profileDir: string;
  private channel: string | undefined;
  // Parsed once in the constructor; spread into every context's options and used to gate
  // the WebRTC-leak launch flag. Undefined → direct egress.
  private proxy: ProxyConfig | undefined;
  private locale: string;
  private languages: string[];
  private timezone: string | undefined;
  /** See BrowserServiceOptions.settleCapMs. Read by the web-browser skill. */
  readonly settleCapMs: number;
  /** See BrowserServiceOptions.cdpEndpoint. Undefined → in-process launch. */
  private cdpEndpoint: string | undefined;
  /** cdpEndpoint without credentials, path or query: what logs and errors show. */
  private cdpEndpointLabel: string | undefined;
  private contextFactory: () => Promise<BrowserContext>;
  // Pending reconnect to the browser container, cleared by stop() (cdpEndpoint only).
  private reconnectTimer: NodeJS.Timeout | null = null;
  // Bumped by stop(). An attach that started before the latest stop() discards its result,
  // even if start() has run again since (cdpEndpoint only).
  private attachGeneration = 0;

  // The persistent context IS the warm browser in this model. Sessions are pages within
  // it (shared cookies/storage = "returning user"); incognito sessions get their own
  // ephemeral context spun off context.browser() (see getOrCreateSession).
  private context: BrowserContext | null = null;
  // Lifecycle flag: true between a successful start() and the start of stop(). The
  // 'disconnected' crash-recovery handler consults it (a) to skip restarting when the
  // disconnect is our own intentional context.close() during stop(), and (b) at the
  // moment an async relaunch resolves — so a relaunch already in flight when stop() runs
  // discards its fresh context instead of reviving a browser after shutdown.
  private running = false;
  // True once a configured browser channel (e.g. 'chrome') failed to launch and we fell
  // back to bundled Chromium — a degraded fingerprint posture. Exposed via
  // isChannelFallbackActive() so health checks can surface the divergence (see #987).
  private channelFallbackActive = false;
  // Ad blocker is loaded lazily on first opt-in (block_ads:true) and cached. Off by
  // default so login/auth/form-fill flows carry no privacy-extension signal.
  // These fields intentionally survive stop()/restart() — the blocklist is process-global
  // data independent of the browser process, so it is reused rather than refetched on
  // each browser restart.
  private blocker: PlaywrightBlocker | null = null;
  private blockerPromise: Promise<PlaywrightBlocker> | null = null;
  private sessions: Map<SessionId, BrowserSession> = new Map();
  private sweepTimer: NodeJS.Timeout | null = null;
  private xvfbProcess: ChildProcess | null = null;
  // Window manager + panel running on our Xvfb display (see startDesktopSession).
  private desktopProcesses: ChildProcess[] = [];

  constructor(options: BrowserServiceOptions) {
    this.logger = options.logger.child({ service: 'BrowserService' });
    this.sessionTtlMs = options.sessionTtlMs ?? 1_800_000;
    this.sweepIntervalMs = options.sweepIntervalMs ?? 120_000;
    this.keepWarmMaxAgeMs = options.keepWarmMaxAgeMs ?? 7_200_000;
    this.profileDir = options.profileDir && options.profileDir.length > 0
      ? options.profileDir
      : join(homedir(), '.curia', 'browser-profile');
    this.channel = options.channel && options.channel.length > 0 ? options.channel : undefined;
    this.proxy = parseProxyConfig(options.proxy);
    this.locale = options.locale && options.locale.length > 0 ? options.locale : 'en-US';
    this.languages = [...new Set([this.locale, ...(options.languages ?? [])])];
    this.timezone = options.timezone;
    this.settleCapMs = options.settleCapMs ?? 35_000;
    this.cdpEndpoint = options.cdpEndpoint && options.cdpEndpoint.length > 0 ? options.cdpEndpoint : undefined;
    this.cdpEndpointLabel = this.cdpEndpoint ? redactCdpEndpoint(this.cdpEndpoint) : undefined;
    if (this.cdpEndpoint) {
      // Fail closed: the proxy exists to keep the datacenter IP from leaking, and a
      // container's default context takes its proxy from Chrome's launch flags, which
      // Curia does not control. Ignoring it would egress directly.
      if (this.proxy) {
        throw new Error(
          'browser.proxy cannot be applied to the browser container: set BROWSER_PROXY on the ' +
          'browser service and clear browser.proxy (see docs/dev/configuration.md).',
        );
      }
      if (this.channel || (options.profileDir && options.profileDir.length > 0)) {
        this.logger.warn(
          { channel: this.channel ?? null, profileDir: options.profileDir || null },
          'browser.channel and browser.profileDir do not apply to the browser container and are ignored',
        );
      }
    }
    this.contextFactory = options.contextFactory
      ?? (this.cdpEndpoint ? () => this.connectToContainer() : () => this.launchPersistentContext());
  }

  /**
   * Start the browser service: spawn Xvfb if needed, launch the persistent browser context, start sweep timer.
   * Must be called before any session operations.
   *
   * With a browser container (cdpEndpoint), start() does not fail when the container is
   * unreachable: the service runs without a browser, health reports it as failed, and it
   * keeps reconnecting until the container answers.
   */
  async start(): Promise<void> {
    if (this.context !== null || this.running) {
      throw new Error('BrowserService.start() called while already running — call stop() first');
    }

    if (this.cdpEndpoint) {
      this.running = true;
      this.sweepTimer = setInterval(() => void this.sweep(), this.sweepIntervalMs);
      this.sweepTimer.unref();
      await this.tryAttach(0);
      this.logger.info({ sessionTtlMs: this.sessionTtlMs, cdpEndpoint: this.cdpEndpointLabel }, 'BrowserService started (browser container)');
      return;
    }

    await this.maybeStartXvfb();
    try {
      this.context = await this.contextFactory();
    } catch (err) {
      // Roll back the Xvfb display we just spawned — otherwise a context-launch failure
      // leaves a stray X server around that breaks later restarts (the stale-:99-lock bug
      // we already guard against on the next start). stop() also kills it, but start()
      // must clean up after itself for callers that don't call stop() on failure.
      if (this.xvfbProcess) {
        this.logger.error({ err }, 'Persistent context launch failed — killing the Xvfb display started for it');
        this.stopDisplay();
      }
      throw err;
    }

    // Restart the persistent context automatically on disconnect (e.g., OOM kill).
    this.attachDisconnectedHandler(this.context);

    this.sweepTimer = setInterval(() => void this.sweep(), this.sweepIntervalMs);
    this.sweepTimer.unref();

    // Mark running only after a fully successful start, so the disconnect handler never
    // tries to recover a service that never finished starting.
    this.running = true;
    this.logger.info({ sessionTtlMs: this.sessionTtlMs }, 'BrowserService started');
  }

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
      // Intentional shutdown — do not restart. stop() flips `running` to false before
      // closing the context, so a disconnect fired by our own teardown (or one that
      // arrives after stop() already finished) is distinguished from an unexpected
      // crash/OOM disconnect.
      if (!this.running) {
        this.logger.debug('Browser disconnected while not running (intentional stop) — skipping crash-recovery restart');
        return;
      }
      this.logger.error(
        this.cdpEndpoint
          ? 'Browser container disconnected — clearing sessions and reconnecting'
          : 'Playwright browser disconnected — clearing sessions and restarting',
      );
      // Best-effort close of any live sessions before dropping them from the map. On a
      // genuine crash/OOM kill the pages are already gone and these close() calls no-op;
      // but if 'disconnected' fires while the process is still alive (explicit close,
      // transport drop), this prevents leaking the underlying pages/contexts.
      const orphaned = [...this.sessions.values()];
      this.sessions.clear();
      for (const session of orphaned) {
        void session.close().catch(err =>
          this.logger.debug({ err }, 'Failed to close orphaned session during disconnect cleanup (browser likely already gone)'),
        );
      }
      if (this.cdpEndpoint) {
        // The container restarts on its own (restart: unless-stopped); keep trying until it
        // answers. Drop the dead context first so health reports 'fail' in the meantime.
        if (this.context === context) this.context = null;
        this.scheduleAttach(0);
        return;
      }
      void this.contextFactory().then(ctx => {
        // stop() may have run while the relaunch was in flight. Reviving the browser now
        // would leak a live context past shutdown, so discard the fresh one instead.
        if (!this.running) {
          this.logger.debug('Relaunch resolved after shutdown — discarding the recovered context');
          void ctx.close().catch(err =>
            this.logger.warn({ err }, 'Failed to close recovered context discarded after shutdown'),
          );
          return;
        }
        this.context = ctx;
        this.attachDisconnectedHandler(ctx);
      }).catch(err => {
        this.logger.error({ err }, 'Browser restart failed');
        // Clear the stale crashed context: a failed relaunch means there is no browser,
        // and the getter must not hand out a reference to a corpse. Since #1762
        // checkBrowser round-trips rather than trusting the reference, so it would
        // report 'fail' here regardless — this is no longer the health check's only
        // line of defence, but leaving a dead reference reachable would still be wrong.
        this.context = null;
      });
    });
  }

  /**
   * Stop the browser service: close all sessions, close the browser, kill Xvfb.
   */
  async stop(): Promise<void> {
    // Flip running=false up front: it tells the 'disconnected' handler that the imminent
    // context.close() is intentional (skip crash-recovery), AND it makes any relaunch
    // already in flight discard its fresh context when it resolves (no revival after stop).
    this.running = false;
    this.attachGeneration++;

    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
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

    if (this.context) {
      try {
        if (this.cdpEndpoint) {
          // Disconnect only. The container's Chrome and its profile outlive Curia, and
          // closing a connected browser just drops the CDP connection.
          await this.context.browser()?.close();
        } else {
          await this.context.close();
        }
      } catch (err) {
        this.logger.error({ err }, 'Error closing browser context during shutdown');
      } finally {
        this.context = null;
      }
    }

    this.stopDisplay();

    this.logger.info('BrowserService stopped');
  }

  /**
   * Get an existing session by ID (refreshing its TTL) or create a new one.
   *
   * - No sessionId → always creates a fresh session.
   * - Valid, non-expired sessionId → refreshes TTL and returns existing session.
   * - Expired sessionId → closes the old session, creates a fresh session with a new ID.
   *
   * opts.incognito → isolated ephemeral context off the same browser (no persistent
   * profile). opts.blockAds → attach the (lazily-fetched) Ghostery ad blocker to the page.
   * opts.keepWarm → pin the session (exempt from the idle TTL, subject to the absolute-age
   * cap) so a parked long-running task can resume the same live page across far-apart wakes.
   * Passing keepWarm:true when reusing an existing session upgrades it to pinned; it is never
   * auto-downgraded (release via closeSession). See ADR-030.
   *
   * Returns the session and its (possibly new) sessionId.
   */
  async getOrCreateSession(
    sessionId: SessionId | undefined,
    opts: { incognito?: boolean; blockAds?: boolean; keepWarm?: boolean } = {},
  ): Promise<{ sessionId: SessionId; session: BrowserSession }> {
    const browser = this.context?.browser();
    if (!this.context || !browser || !browser.isConnected()) {
      if (this.cdpEndpoint && this.running) {
        // Written for the operator: the agent relays it as is.
        throw new Error(
          `the browser container at ${this.cdpEndpointLabel} is not reachable. Curia reconnects on its own ` +
          'once it is back; check it with `docker compose ps browser` and `docker compose logs browser`.',
        );
      }
      throw new Error('BrowserService: browser is not running. Call start() first.');
    }

    if (sessionId) {
      const existing = this.sessions.get(sessionId);
      if (existing && !existing.isExpired(this.sessionTtlMs, this.keepWarmMaxAgeMs)) {
        existing.lastUsedAt = Date.now();
        // Upgrade to pinned if the caller now wants to keep this session warm across wakes.
        if (opts.keepWarm) existing.keepWarm = true;
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
        await page.close().catch(closeErr =>
          this.logger.debug({ err: closeErr }, 'Failed to close page during session-creation cleanup'),
        );
      }
      throw err;
    }

    const newSessionId = randomUUID();
    const session = new BrowserSession(ownedContext ?? this.context, page, ownedContext);
    // Pin from creation when the caller asked to keep this session warm across wakes.
    if (opts.keepWarm) session.keepWarm = true;

    // Crash safety: if the page crashes, invalidate the session so the next
    // skill call starts fresh rather than retrying on a broken page.
    page.on('crash', () => {
      this.logger.error({ sessionId: newSessionId }, 'Page crashed — removing session');
      void session.close().catch(() => {});
      this.sessions.delete(newSessionId);
    });

    // Page errors, kept on the session so a blank or unsettled page can be diagnosed
    // (#2244). Under Patchright 'console' carries only browser-reported entries (failed
    // loads, CSP and security errors); see BrowserSession.consoleErrors.
    page.on('console', (message) => {
      if (message.type() === 'error') session.recordConsoleError(message.text());
    });
    page.on('pageerror', (error) => {
      session.recordConsoleError(`Uncaught ${error.name}: ${error.message}`);
    });

    this.sessions.set(newSessionId, session);
    this.logger.debug(
      { sessionId: newSessionId, incognito: opts.incognito === true, blockAds: opts.blockAds === true, keepWarm: opts.keepWarm === true },
      'New browser session created',
    );

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
    const expired = [...this.sessions.entries()].filter(([, s]) => s.isExpired(this.sessionTtlMs, this.keepWarmMaxAgeMs));
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

  /**
   * True if a configured browser channel failed to launch and the service degraded to
   * bundled Chromium (a weaker fingerprint than configured). Lets health checks surface
   * the configured-vs-actual divergence rather than leaving it buried in a log line (#987).
   */
  isChannelFallbackActive(): boolean {
    return this.channelFallbackActive;
  }

  /**
   * Expose the persistent browser context for liveness probes. Null when the service
   * has not been started or has been stopped.
   *
   * The probe (`checkBrowser`) does a bounded `cookies()` round-trip into Chrome. It
   * deliberately does NOT use `isConnected()`, which this comment previously claimed:
   * that is synchronous cached transport state, so a wedged-but-connected renderer
   * still reports true (#1762).
   */
  get browserContext(): BrowserContext | null {
    return this.context;
  }

  // --- Private helpers ---

  /**
   * One attach attempt to the browser container. On failure, schedules the next one with
   * backoff. Never throws: an unreachable container leaves the service without a browser
   * (health 'fail'), not stopped.
   */
  private async tryAttach(attempt: number): Promise<void> {
    if (!this.running) return;
    const generation = this.attachGeneration;
    const attach = this.contextFactory();
    let deadline: NodeJS.Timeout | undefined;
    let context: BrowserContext;
    try {
      context = await Promise.race([
        attach,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new Error(`attaching took longer than ${CDP_ATTACH_DEADLINE_MS}ms`)), CDP_ATTACH_DEADLINE_MS);
        }),
      ]);
    } catch (err) {
      // An attach that outlived its deadline may still complete: drop that connection.
      void attach.then(
        late => late.browser()?.close(),
        () => undefined, // already reported below as this attempt's failure
      ).catch(closeErr => this.logger.debug({ err: closeErr }, 'Failed to disconnect a late attach'));
      if (attempt % CDP_RECONNECT_WARN_EVERY === 0) {
        this.logger.warn(
          { error: sanitizeCdpError(err), cdpEndpoint: this.cdpEndpointLabel, attempt },
          'Browser container not reachable — web-browser is unavailable until it is; retrying',
        );
      } else {
        this.logger.debug({ error: sanitizeCdpError(err), attempt }, 'Browser container still not reachable');
      }
      // A stale attempt (stop() and start() ran since) must not arm a second reconnect
      // loop beside the current generation's.
      if (generation === this.attachGeneration) this.scheduleAttach(attempt + 1);
      return;
    } finally {
      clearTimeout(deadline);
    }
    // stop() may have run while the attach was in flight: disconnect instead of reviving.
    if (!this.running || generation !== this.attachGeneration) {
      void context.browser()?.close().catch(err =>
        this.logger.warn({ err }, 'Failed to disconnect from the browser container after shutdown'),
      );
      return;
    }
    // A concurrent attach of this generation already won: keep it, drop this connection.
    if (this.context) {
      void context.browser()?.close().catch(err =>
        this.logger.warn({ error: sanitizeCdpError(err) }, 'Failed to disconnect a duplicate attach to the browser container'),
      );
      return;
    }
    // Only the attach that wins tidies the previous run's tabs, and it lists them before
    // publishing the context, while no session can exist: a superseded attach must never
    // close tabs, since by then they may belong to the winner's live sessions.
    const leftovers = this.listLeftovers(context);
    this.context = context;
    this.attachDisconnectedHandler(context);
    // A browser that dropped after connecting but before the listener above was attached
    // fired 'disconnected' to nobody. Catch that here, or the dead context would stay.
    if (!context.browser()?.isConnected()) {
      this.logger.warn('Browser container disconnected while attaching — retrying');
      this.context = null;
      this.scheduleAttach(attempt + 1);
      return;
    }
    await this.closeLeftovers(leftovers);
  }

  /**
   * Tabs and incognito contexts left in the container by a previous Curia process: their
   * sessions died with it, and nothing else would ever close them. The first tab stays:
   * it is the window's anchor, and Chrome exits when its last window closes.
   */
  private listLeftovers(context: BrowserContext): { tabs: Page[]; contexts: BrowserContext[] } {
    return {
      tabs: context.pages().slice(1),
      contexts: (context.browser()?.contexts() ?? []).filter(c => c !== context),
    };
  }

  private async closeLeftovers(leftovers: { tabs: Page[]; contexts: BrowserContext[] }): Promise<void> {
    for (const stale of [...leftovers.contexts, ...leftovers.tabs]) {
      await stale.close().catch(err => this.logger.warn({ err }, 'Failed to close a tab or context left by a previous run'));
    }
    if (leftovers.contexts.length + leftovers.tabs.length > 0) {
      this.logger.info({ tabs: leftovers.tabs.length, contexts: leftovers.contexts.length }, 'Closed tabs left in the browser container by a previous run');
    }
  }

  /**
   * Schedule attach attempt number `attempt` (0 after a disconnect, 1 after the first
   * failure): 1s for the first retry, doubling to CDP_RECONNECT_MAX_DELAY_MS.
   */
  private scheduleAttach(attempt: number): void {
    if (!this.running || this.reconnectTimer) return;
    const delayMs = Math.min(1_000 * 2 ** Math.min(Math.max(attempt - 1, 0), 10), CDP_RECONNECT_MAX_DELAY_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.tryAttach(attempt);
    }, delayMs);
    this.reconnectTimer.unref();
  }

  /**
   * Attach to the browser container over CDP and return its default context: the
   * persistent profile, since the container launches Chrome with --user-data-dir.
   *
   * It closes nothing: tabs a previous run left are closed by tryAttach, and only for the
   * attach that wins (see listLeftovers).
   */
  private async connectToContainer(): Promise<BrowserContext> {
    const endpoint = await resolveCdpEndpoint(this.cdpEndpoint!);
    const browser = await chromium.connectOverCDP(endpoint, { timeout: CDP_CONNECT_TIMEOUT_MS }) as unknown as Browser;
    const [context] = browser.contexts();
    if (!context) {
      await browser.close().catch(err => this.logger.debug({ err }, 'Failed to disconnect from a browser with no default context'));
      throw new Error('the browser container has no default context — is Chrome running with --user-data-dir?');
    }
    this.logger.info({ cdpEndpoint: this.cdpEndpointLabel, version: browser.version() }, 'Attached to the browser container');
    return context;
  }

  /**
   * Fingerprint/context options shared by the persistent context and any incognito context.
   * We deliberately DO NOT set userAgent (or any sec-ch-ua / userAgentData override): with
   * the real Chrome channel, Chrome natively emits a COMPLETE, mutually-consistent identity
   * set (UA + client hints + userAgentData) for the true binary version and OS. Overriding
   * any single surface without perfectly mirroring the others manufactures exactly the
   * inconsistency detection keys on — and a hardcoded UA goes stale into a bot tell (#987).
   * timezoneId is set only when a timezone is configured, aligning the context with the
   * principal. (#1053)
   *
   * The proxy (when configured) is spread here so it applies to BOTH the persistent context
   * (launchPersistentContext) and any incognito context (browser.newContext) — routing all
   * browser egress through, e.g., a residential home-network exit. (residential-proxy support)
   *
   * viewport and locale are deliberately absent too (#2221). A Playwright viewport is CDP
   * device-metrics emulation, which also forces `screen` to the viewport size, so the window
   * read bigger than its own screen. With no viewport, the page takes the real window
   * (WINDOW_SIZE) on the real Xvfb screen (SCREEN_SIZE). Playwright's `locale` collapses
   * navigator.languages to one entry; the --lang / --accept-lang launch flags set the
   * full list natively instead, and they also cover incognito contexts.
   */
  private buildContextOptions(): BrowserContextOptions {
    return {
      viewport: null,
      colorScheme: 'light',
      ...(this.timezone ? { timezoneId: this.timezone } : {}),
      ...(this.proxy ? { proxy: this.proxy } : {}),
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
   * patchright returns its own BrowserContext, structurally identical to the
   * 'playwright' BrowserContext we type against.
   */
  private async launchPersistentContext(): Promise<BrowserContext> {
    // Clear a stale Chrome SingletonLock left by a previous unclean exit. The profile
    // lives on a persistent volume (so logins survive restarts), but Chrome records the
    // lock owner as "<hostname>-<pid>" and Docker assigns a new hostname (container id) on
    // every recreate. After a hard restart the lock names a now-dead container, so Chrome
    // reads it as "in use on another computer" and refuses to launch — taking the real
    // channel AND the bundled-Chromium fallback down with it (regression of #987). The profile is
    // single-owner (only this service drives it, and start() launches only when context is
    // null), so any lock present at launch is necessarily stale. Mirrors clearStaleX11Lock.
    clearStaleSingletonLock({ profileDir: this.profileDir, logger: this.logger });

    const baseOptions = {
      headless: false,
      // Chrome always runs its own sandbox, so a renderer exploit still needs a second bug to
      // reach this process's files, environment or network. Playwright adds --no-sandbox
      // unless this is true. Deliberately not configurable: an off switch is the first thing
      // tried when the sandbox fails to start, and the fix is the seccomp profile. (#2521)
      chromiumSandbox: true,
      args: [
        // Patchright owns the navigator.webdriver / AutomationControlled surface, so we no
        // longer pass --disable-blink-features=AutomationControlled (stacking a flag it
        // manages is a documented anti-pattern). A container requirement. (#1053)
        '--disable-dev-shm-usage',
        // When egressing through a proxy, force WebRTC to only use proxied UDP so a STUN
        // candidate can't leak the real (datacenter) IP behind the residential exit. This is
        // a browser-process-level flag, so it also covers incognito contexts spun off this
        // launch. Only added when a proxy is set. (residential-proxy support)
        ...(this.proxy ? ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] : []),
        // A desktop-sized window that sits inside the larger Xvfb screen, so
        // screen >= availHeight >= outerHeight > innerHeight holds the way it does on a
        // real device. (#2221)
        `--window-size=${WINDOW_SIZE.width},${WINDOW_SIZE.height}`,
        // Locale natively: --lang sets the UI/Intl locale, --accept-lang sets
        // navigator.languages and the Accept-Language header to the same ordered list. (#2221)
        `--lang=${this.locale}`,
        `--accept-lang=${this.languages.join(',')}`,
      ],
      env: chromeLaunchEnv(process.env, this.locale),
      ...this.buildContextOptions(),
    };

    // Reset before each attempt so the flag reflects the CURRENT launch, not a stale
    // historical fallback — otherwise a later successful relaunch (crash recovery, or a
    // start() after stop()) would still report a degraded channel forever.
    this.channelFallbackActive = false;

    try {
      const context = await chromium.launchPersistentContext(
        this.profileDir,
        this.channel ? { ...baseOptions, channel: this.channel } : baseOptions,
      ) as unknown as BrowserContext;
      this.logChannel(context, this.channel);
      return context;
    } catch (err) {
      if (!this.channel) {
        // No channel to fall back from. A sandbox failure gets the sandbox message.
        if (isSandboxLaunchFailure(err)) throw this.sandboxLaunchError(err);
        throw err; // a genuine launch failure
      }
      // With a channel set, even a sandbox failure falls through to bundled Chromium, still
      // sandboxed: a host policy (e.g. AppArmor) can allow one binary and deny the other.
      // If bundled Chromium fails to sandbox too, that is reported below.
      // Configured-vs-actual divergence: the operator asked for a real browser channel
      // (the whole point of the fingerprint hardening) and we couldn't honour it — almost
      // always a missing browser in the image. Degrade to bundled Chromium so the skill
      // still works, but log at ERROR (not warn): production is now running a materially
      // weaker fingerprint than configured, and that must be loud/alertable, not buried.
      // `channelFallbackActive` exposes the degraded posture for health checks/greppability.
      this.channelFallbackActive = true;
      this.logger.error(
        { err, requestedChannel: this.channel },
        'Browser channel launch failed — DEGRADED to bundled Chromium (weaker fingerprint than configured); is the channel installed in the image, and can it start its sandbox?',
      );
      let context: BrowserContext;
      try {
        context = await chromium.launchPersistentContext(
          this.profileDir,
          baseOptions,
        ) as unknown as BrowserContext;
      } catch (fallbackErr) {
        const channelSandboxFailure = isSandboxLaunchFailure(err);
        const fallbackSandboxFailure = isSandboxLaunchFailure(fallbackErr);
        if (!channelSandboxFailure && !fallbackSandboxFailure) throw fallbackErr;
        // A sandbox failure on either launch is the one the operator can act on, whatever
        // else stopped the other launch, so it is the one reported.
        if (!fallbackSandboxFailure) {
          this.logger.error({ err: fallbackErr }, 'Bundled Chromium fallback failed to launch');
        }
        throw this.sandboxLaunchError(fallbackSandboxFailure ? fallbackErr : err, {
          channel: this.channel,
          channelSandboxFailure,
          fallbackSandboxFailure,
        });
      }
      this.logChannel(context, undefined);
      return context;
    }
  }

  /**
   * The error for a launch that died because Chrome could not set up its sandbox. Never
   * retried without the sandbox: the web-browser skill is unavailable until the host
   * allows it. (#2521)
   *
   * `channelAttempt` is set when a configured channel was tried first: the advice to use
   * `channel: chrome` would then be no help, so the message says what that launch hit.
   */
  private sandboxLaunchError(
    cause: unknown,
    channelAttempt?: { channel: string; channelSandboxFailure: boolean; fallbackSandboxFailure: boolean },
  ): Error {
    const appArmorAdvice =
      "on Ubuntu 23.10+ from source, check that the host's AppArmor profile for that browser allows user namespaces ";
    let hostAdvice: string;
    if (!channelAttempt) {
      hostAdvice = 'On Ubuntu 23.10+ from source, use channel: chrome ';
    } else if (channelAttempt.channelSandboxFailure && channelAttempt.fallbackSandboxFailure) {
      hostAdvice = `channel: ${channelAttempt.channel} could not sandbox either: ${appArmorAdvice}`;
    } else if (channelAttempt.channelSandboxFailure) {
      hostAdvice =
        `channel: ${channelAttempt.channel} could not sandbox, and bundled Chromium did not start ` +
        `(see the earlier error; is it installed?): ${appArmorAdvice}`;
    } else {
      hostAdvice =
        `channel: ${channelAttempt.channel} did not start (see the earlier error; is it installed?), ` +
        'and bundled Chromium could not sandbox ';
    }
    const message =
      'Chrome sandbox could not start: the host blocks the user namespaces it needs, ' +
      'or Curia is running as root (Chrome refuses its sandbox as root; run as a non-root user). ' +
      'A setuid sandbox (chrome-sandbox) error means the same: Chrome falls back to it when namespaces are blocked. ' +
      'In a container, run it with the seccomp profile in docker/seccomp-chrome.json. ' +
      hostAdvice +
      '(see docs/dev/configuration.md).';
    this.logger.error({ err: cause }, message);
    return new Error(message, { cause });
  }

  /** Log the resolved channel + real browser version for observability (UA traceability). */
  private logChannel(context: BrowserContext, channel: string | undefined): void {
    const version = context.browser()?.version();
    // Log the proxy server (never the credentials) so the egress posture is greppable —
    // a residential exit vs. direct datacenter egress is exactly what we want observable.
    this.logger.info(
      { channel: channel ?? 'chromium', version, profileDir: this.profileDir, proxy: this.proxy?.server ?? null },
      'Persistent browser context launched',
    );
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

    // Clear a stale :99 lock left by a previous unclean exit (crash, OOM, hard
    // restart). stop() removes Xvfb on graceful shutdown, but cannot run on a hard
    // crash — and the lock/socket survive in the container's writable layer across
    // a `docker restart`, so cleanup-before-start is the only robust place to handle
    // it. Guarded on a live X server so a genuinely active display is never clobbered.
    clearStaleX11Lock({ displayNum: 99, logger: this.logger });

    this.logger.info('Spawning Xvfb virtual display on :99');
    this.xvfbProcess = spawn('Xvfb', [':99', '-screen', '0', `${SCREEN_SIZE.width}x${SCREEN_SIZE.height}x24`], {
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

    await this.startDesktopSession();
  }

  /**
   * Run a window manager and a panel on our Xvfb display (#2221). Bare Xvfb has no work
   * area, so screen.availHeight equals screen.height — the `noTaskbar` tell CreepJS counts
   * toward "like headless". openbox publishes _NET_WORKAREA minus the strut tint2's bottom
   * panel reserves, and Chrome reports that as the available screen.
   *
   * Best-effort: without the binaries the browser still works, just with the tell, so a
   * failure warns instead of failing start().
   */
  private async startDesktopSession(): Promise<void> {
    const programs: Array<[string, string[]]> = [['openbox', ['--sm-disable']], ['tint2', []]];
    for (const [command, args] of programs) {
      const proc = await this.spawnDesktopProcess(command, args);
      // No point starting the panel without a WM: nothing would turn its strut into a work area.
      if (!proc) return;
      this.desktopProcesses.push(proc);
    }
    this.logger.info('Window manager and panel started on DISPLAY=:99');
  }

  /** Spawn one desktop program; resolve it if still running after 500ms, else warn and resolve null. */
  private spawnDesktopProcess(command: string, args: string[]): Promise<ChildProcess | null> {
    const proc = spawn(command, args, { stdio: 'ignore', detached: false });
    return new Promise(resolve => {
      const settle = (result: ChildProcess | null) => {
        clearTimeout(timer);
        proc.off('error', onError);
        proc.off('close', onClose);
        resolve(result);
      };
      const fail = (reason: string) => {
        this.logger.warn(
          { command, reason },
          'Desktop session program failed to start — screen.availHeight will equal screen.height (a headless fingerprint tell); is it installed in the image?',
        );
        settle(null);
      };
      const onError = (err: Error) => fail(err.message);
      const onClose = (code: number | null) => fail(`exited during startup (code ${code ?? 'null'})`);
      proc.once('error', onError);
      proc.once('close', onClose);
      const timer = setTimeout(() => settle(proc), 500);
    });
  }

  /** Kill the desktop session and the Xvfb display we spawned, if any. */
  private stopDisplay(): void {
    for (const proc of this.desktopProcesses) proc.kill();
    this.desktopProcesses = [];
    if (this.xvfbProcess) {
      this.xvfbProcess.kill();
      this.xvfbProcess = null;
    }
  }
}

/**
 * Rewrite a DevTools endpoint's hostname to its IP address. Chrome answers a DevTools
 * request only when its Host header is an IP address or `localhost` (a DNS-rebinding
 * guard), so `http://browser:9222` is refused while the same container by IP is not.
 * The WebSocket URL Chrome hands back echoes that Host, so it stays connectable. (#2541)
 */
export async function resolveCdpEndpoint(
  endpoint: string,
  // IPv4: the container's DevTools forwarder listens on IPv4 only.
  lookup: (hostname: string) => Promise<{ address: string }> = hostname => dnsLookup(hostname, { family: 4 }),
): Promise<string> {
  const url = new URL(endpoint);
  // TLS endpoints keep their hostname: the certificate is issued for it.
  if (url.protocol === 'https:' || url.protocol === 'wss:') return endpoint;
  // URL keeps IPv6 literals bracketed in hostname.
  const bare = url.hostname.replace(/^\[(.*)\]$/, '$1');
  if (isIP(bare) !== 0 || bare === 'localhost') return endpoint;
  const { address } = await lookup(bare);
  // A compose service name resolves to a private address. A public one means the name
  // leaked to outside DNS (the container is down and a search domain answered), and
  // Curia would hand its browsing, typed secrets included, to that host.
  if (!isPrivateAddress(address)) {
    throw new Error(`${bare} resolved to a public address, not a container on this host; refusing to attach`);
  }
  url.hostname = isIP(address) === 6 ? `[${address}]` : address;
  return url.toString();
}

/** True for loopback, RFC 1918, link-local and IPv6 unique-local/link-local addresses. */
function isPrivateAddress(address: string): boolean {
  const a = address.toLowerCase();
  return /^(127|10)\./.test(a)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(a)
    || /^192\.168\./.test(a)
    || /^169\.254\./.test(a)
    || a === '::1'
    || /^f[cd][0-9a-f]{2}:/.test(a)
    || /^fe[89ab][0-9a-f]:/.test(a);
}

/** An endpoint as logs and errors may show it: scheme and host only, so a token in the
 *  userinfo, path or query of a hosted browser's URL is never written out. */
export function redactCdpEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    return `${url.protocol}//${url.host}`;
  } catch {
    return '<invalid endpoint>';
  }
}

/** An attach error as logs may show it: every URL in the message (the endpoint, or the
 *  /json/version/ discovery URL Patchright derives from it) is cut back to scheme and host,
 *  and the stack is dropped, since it repeats the message. */
export function sanitizeCdpError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/\b(?:https?|wss?):\/\/[^\s'"<>]+/gi, match => redactCdpEndpoint(match));
}

interface ClearStaleX11LockOptions {
  /** X display number (e.g. 99 for `:99`). */
  displayNum: number;
  logger: Logger;
  /** Base tmp directory holding the lock + socket. Defaults to '/tmp'. Overridable for tests. */
  tmpDir?: string;
  /**
   * Liveness probe for the PID recorded in the lock file. Defaults to a real
   * check that the process is both alive AND an X server (to survive PID reuse).
   * Overridable for tests.
   */
  isProcessAlive?: (pid: number) => boolean;
}

/**
 * Remove a stale X11 lock file (`/tmp/.X<n>-lock`) and socket (`/tmp/.X11-unix/X<n>`)
 * left behind by a previous unclean exit, but only when no live X server owns the
 * display. Returns true if any stale file was removed.
 *
 * The whole check is gated on the lock file, because that is the authoritative signal
 * of display ownership: an X server always creates `/tmp/.X<n>-lock` (recording its
 * PID, left-padded to 10 chars) when it claims a display. We read that PID and probe
 * liveness — if the owner is a genuinely live X server we leave everything untouched
 * so an active display is never clobbered. If the PID is dead, missing, or unparseable,
 * the lock is an orphan from a crash and we remove it together with its socket.
 *
 * We deliberately do NOT remove a socket when no lock file is present: with no recorded
 * PID we can't prove the display is free, so removing it could clobber a live server
 * (guard on a live process, not file presence). A genuinely orphaned lockless socket is
 * harmless — the X server unlinks and recreates a stale socket itself on startup.
 */
export function clearStaleX11Lock(opts: ClearStaleX11LockOptions): boolean {
  const { displayNum, logger, tmpDir = '/tmp' } = opts;
  // Default probe needs the logger so it can surface (not swallow) /proc read failures.
  const isProcessAlive = opts.isProcessAlive ?? ((pid: number) => isLiveXServer(pid, logger));
  const lockPath = `${tmpDir}/.X${displayNum}-lock`;
  const socketPath = `${tmpDir}/.X11-unix/X${displayNum}`;

  // No lock file → the X server considers `:${displayNum}` free. Nothing to clean,
  // and without a recorded PID we have no safe basis to remove the socket.
  if (!existsSync(lockPath)) return false;

  // A lock file with a live X-server owner means the display is genuinely in use —
  // bail out without touching anything.
  const pid = readLockPid(lockPath, logger);
  if (pid !== null && isProcessAlive(pid)) {
    logger.warn({ display: `:${displayNum}`, pid }, 'Xvfb lock owned by a live X server — leaving it alone');
    return false;
  }

  // No live owner — remove the orphaned lock and socket from the prior unclean exit.
  let removed = false;
  for (const path of [lockPath, socketPath]) {
    if (!existsSync(path)) continue;
    try {
      rmSync(path, { force: true });
      removed = true;
    } catch (err) {
      logger.error({ err, path }, 'Failed to remove stale Xvfb file — Xvfb may fail to claim the display');
    }
  }
  if (removed) {
    logger.warn({ display: `:${displayNum}` }, 'Removed stale Xvfb lock/socket left by a previous unclean exit');
  }
  return removed;
}

interface ClearStaleSingletonLockOptions {
  /** The persistent Chrome profile directory holding the Singleton* lock files. */
  profileDir: string;
  logger: Logger;
  /**
   * This host's name — what Chrome compares the lock owner against. Defaults to
   * os.hostname() (the Docker container id in production). Overridable for tests.
   */
  hostname?: string;
  /**
   * Liveness probe for the lock-owner PID. Only consulted when the lock was created by
   * THIS host (same hostname) — a PID from another host is meaningless locally. Defaults
   * to a real `process.kill(pid, 0)` existence check. Overridable for tests.
   */
  isProcessAlive?: (pid: number) => boolean;
}

/**
 * Remove a stale Chrome `SingletonLock` (and its `SingletonCookie` / `SingletonSocket`
 * siblings) from a persistent profile directory, left behind when Chrome exited uncleanly
 * (crash, OOM, `docker kill`). Returns true if any file was removed.
 *
 * Chrome writes `SingletonLock` as a symlink whose target is `"<hostname>-<pid>"`, recording
 * which machine+process owns the profile. On a persistent-profile volume this is a trap:
 * the volume survives container restarts, but Docker assigns a fresh hostname (the container
 * id) on every recreate. So after a hard restart the lock names a now-dead *previous*
 * container; Chrome can't prove that owner is gone ("in use on another computer") and refuses
 * to launch rather than steal the lock. Because this profile is single-owner — only
 * BrowserService drives it, and it launches only when no context is live — any lock present
 * at launch time is necessarily stale, with one exception we still guard: a lock created by
 * THIS host whose PID is genuinely alive (a real concurrent owner) is left untouched.
 *
 * Gated on the lock symlink, mirroring `clearStaleX11Lock`: an unreadable/unparseable lock is
 * treated as having no provable live owner and removed, so a corrupt lock can never wedge
 * startup. We probe with lstat (not existsSync) because a dangling Singleton* symlink — its
 * target never existed on this host — would otherwise read as "missing".
 */
export function clearStaleSingletonLock(opts: ClearStaleSingletonLockOptions): boolean {
  const { profileDir, logger } = opts;
  const hostname = opts.hostname ?? osHostname();
  // Default probe: signal 0 delivers nothing, it only tests whether the PID exists.
  const isProcessAlive = opts.isProcessAlive ?? defaultIsProcessAlive;

  const lockPath = join(profileDir, 'SingletonLock');
  const cookiePath = join(profileDir, 'SingletonCookie');
  const socketPath = join(profileDir, 'SingletonSocket');

  // No lock symlink → Chrome considers the profile free; nothing to clean. lstat (not
  // existsSync) so a dangling symlink is still detected as present.
  if (!symlinkExists(lockPath)) return false;

  // A live owner on THIS host means a genuine concurrent Chrome — never clobber it.
  // For any other case (different host, dead PID, unparseable target) the lock is an
  // orphan and we remove it.
  const owner = readSingletonLockOwner(lockPath, logger);
  if (owner && owner.hostname === hostname && isProcessAlive(owner.pid)) {
    logger.warn({ profileDir, pid: owner.pid }, 'Chrome SingletonLock owned by a live local process — leaving it alone');
    return false;
  }

  let removed = false;
  for (const path of [lockPath, cookiePath, socketPath]) {
    if (!symlinkExists(path)) continue;
    try {
      rmSync(path, { force: true });
      removed = true;
    } catch (err) {
      logger.error({ err, path }, 'Failed to remove stale Chrome Singleton* file — browser may refuse to claim the profile');
    }
  }
  if (removed) {
    logger.warn(
      { profileDir, lockOwner: owner ? `${owner.hostname}-${owner.pid}` : 'unparseable' },
      'Removed stale Chrome SingletonLock left by a previous unclean exit',
    );
  }
  return removed;
}

/** Default liveness probe: true iff `pid` exists on this host (signal 0 = existence check). */
function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH → no such process. EPERM → process exists but we can't signal it (still alive).
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * True if `path` is an existing symlink/file, probing the link itself (not its target) so a
 * dangling Singleton* symlink still counts as present. `throwIfNoEntry: false` turns a missing
 * path into `undefined` instead of a thrown ENOENT — so there is no catch swallowing errors,
 * and a genuine stat failure (EACCES, EIO) still throws rather than masquerading as "absent".
 */
function symlinkExists(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}

/**
 * Parse Chrome's `SingletonLock` symlink target of the form `"<hostname>-<pid>"` into its
 * owner. The hostname may itself contain hyphens, so we split on the LAST hyphen. Returns
 * null if the lock can't be read or the pid component isn't a positive integer — callers
 * treat that as "no provable live owner" and remove the lock.
 */
function readSingletonLockOwner(lockPath: string, logger: Logger): { hostname: string; pid: number } | null {
  let target: string;
  try {
    target = readlinkSync(lockPath);
  } catch (err) {
    // Don't swallow, but don't propagate: this cleanup keeps startup resilient, so an
    // unreadable lock must degrade to removal rather than throw and disable the skill.
    logger.warn({ err, lockPath }, 'Could not read Chrome SingletonLock target — treating as stale');
    return null;
  }
  const lastDash = target.lastIndexOf('-');
  if (lastDash <= 0) return null; // no hostname or no pid component
  // Strict digits-only: Number.parseInt is too lax (`parseInt('44garbage') === 44`), which
  // would treat a corrupt target as a valid owner and — if that PID is live on this host —
  // preserve an effectively-stale lock and keep Chrome wedged. A non-numeric pid component
  // is unparseable → null → caller removes the lock (the safe direction).
  const pidStr = target.slice(lastDash + 1);
  if (!/^\d+$/.test(pidStr)) return null;
  const pid = Number.parseInt(pidStr, 10);
  if (pid <= 0) return null;
  return { hostname: target.slice(0, lastDash), pid };
}

/** Read the owning PID from an X11 lock file. Returns null if absent or unparseable. */
function readLockPid(lockPath: string, logger: Logger): number | null {
  try {
    // Format: PID left-padded to 10 chars plus a trailing newline. parseInt skips leading space.
    const pid = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (err) {
    // Log rather than swallow, but deliberately do NOT propagate: this cleanup exists to
    // keep BrowserService startup resilient, so an unreadable lock must degrade (treat as
    // no valid owner → caller attempts removal) rather than throw and disable the skill.
    logger.warn({ err, lockPath }, 'Could not read X11 lock PID — treating lock as having no live owner');
    return null;
  }
}

// X server binaries follow the convention of an executable named `X` or `X<name>`
// (Xvfb, Xorg, Xwayland, Xephyr, Xvnc, …). We match the basename of argv[0] against
// known names plus that convention, rather than substring-matching the whole command
// line, so any live X server flavour is recognised (not just Xvfb/Xorg) and an
// unrelated process that merely mentions "Xorg" in an argument is not misclassified.
const X_SERVER_BINARIES = new Set(['X', 'Xvfb', 'Xorg', 'Xwayland', 'Xephyr', 'Xvnc', 'Xnest']);

// What in-process Chrome (and its children) may see of Curia's environment (#2521): what
// it needs to find its binaries, display, fonts and temp space, and nothing else. Never
// SECRET_ENCRYPTION_KEY, DATABASE_URL or API keys. LC_* is left out too: an inherited
// LC_ALL would override the LANG set below. The display/session variables (XAUTHORITY,
// WAYLAND_DISPLAY, DBUS_SESSION_BUS_ADDRESS) hold paths and socket addresses, no secrets;
// startDisplay reuses an existing DISPLAY, and on GDM/Xwayland the cookie is only found
// through XAUTHORITY. HTTP(S)_PROXY/NO_PROXY are left out on purpose: they can embed proxy
// credentials, and the browser's proxy is configured through BrowserService's own proxy option.
const CHROME_ENV_ALLOWLIST = [
  'HOME', 'PATH', 'TZ', 'DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'TMPDIR',
  'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
  'FONTCONFIG_FILE', 'FONTCONFIG_PATH',
] as const;

/**
 * The environment for an in-process Chrome launch (#2521): the allowlisted variables
 * present in `parent`, plus LANG for `locale`. On Linux Chrome takes its ICU (Intl) locale
 * from LANG, not --lang, so without it Intl reports en-US beside an en-CA
 * navigator.language (#2221).
 *
 * Defence in depth only: in-process Chrome runs as Curia's user, so code that escapes its
 * sandbox can still read Curia's environment from /proc/<pid>/environ. Keeping secrets
 * from Chrome takes the browser container (#2541).
 */
export function chromeLaunchEnv(parent: NodeJS.ProcessEnv, locale: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of CHROME_ENV_ALLOWLIST) {
    const value = parent[key];
    if (value !== undefined) env[key] = value;
  }
  env.LANG = `${locale.replace('-', '_')}.UTF-8`;
  return env;
}

/**
 * True if `binary` (an executable basename) is an X server: a known server name, or
 * the `X<name>` convention (capital X + lowercase initial, alphanumeric, no separators —
 * so `Xfoo` matches but `Xfce4-session`, `xterm`, and `node` do not).
 */
export function isXServerBinary(binary: string): boolean {
  return X_SERVER_BINARIES.has(binary) || /^X[a-z][A-Za-z0-9]*$/.test(binary);
}

/**
 * True if a launch error is Chrome failing to set up its sandbox (#2521). Chrome reports
 * it only on stderr, which Playwright copies into the error message, so this matches that
 * text. "Failed to move to new namespace" is Docker's default seccomp profile refusing
 * the user namespace; "No usable sandbox" is Chromium finding neither the namespace nor
 * the setuid sandbox. "Chromium sandboxing failed!" is Patchright's rewrite of Chrome's
 * "Running as root without --no-sandbox is not supported" refusal. The setuid patterns
 * cover Chromium falling back to a setuid helper that is missing its root/4755 setup
 * ("The SUID sandbox helper binary was found, but is not configured correctly", "The
 * setuid sandbox is not running as root").
 */
export function isSandboxLaunchFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /Failed to move to new namespace|No usable sandbox|Chromium sandboxing failed|SUID sandbox helper|setuid sandbox/i.test(message);
}

/**
 * Default liveness probe: true only if `pid` is alive AND looks like an X server.
 * The X-server check (via /proc/<pid>/cmdline) guards against PID reuse, where the
 * recorded PID has been recycled by some unrelated process. If liveness is confirmed
 * but the command line can't be read, we conservatively assume the display is owned
 * (better to skip cleanup than risk clobbering a live server).
 */
function isLiveXServer(pid: number, logger: Logger): boolean {
  try {
    // Signal 0 performs no signal delivery — it only probes for the process's existence.
    process.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false; // no such process
    // EPERM: the process exists but we can't signal it — still alive, fall through.
  }
  try {
    // cmdline is NUL-separated; argv[0] is the executable path. Compare its basename
    // against the X-server naming convention so all server flavours are recognised.
    const argv0 = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')[0] ?? '';
    const binary = argv0.slice(argv0.lastIndexOf('/') + 1);
    return isXServerBinary(binary);
  } catch (err) {
    // Couldn't inspect the command line; the process is alive, so conservatively assume
    // it owns the display (never clobber a live server). Logged, not swallowed; not
    // propagated, since that would defeat the resilient-startup purpose of this check.
    logger.warn({ err, pid }, 'Could not inspect lock-owner cmdline — assuming the live process owns the display');
    return true;
  }
}
