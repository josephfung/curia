// src/browser/browser-service.ts — manages a warm Playwright browser and session map.
//
// A single PERSISTENT browser context is launched at startup (the principal's profile)
// and kept warm. Sessions are PAGES within that one shared context, so they share
// cookies/storage/cache — the site sees a "returning user", not a fresh anonymous
// browser each time. An opt-in incognito session instead gets its own isolated ephemeral
// context spun off the same browser (never touching the persistent profile).
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
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium as stealthChromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { BrowserContext, BrowserContextOptions } from 'playwright';
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

export class BrowserService {
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
  // Set to true by stop() before closing the context so the 'disconnected' handler
  // knows the disconnect is intentional and must NOT trigger a crash-recovery restart.
  private stopping = false;
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

  /**
   * Start the browser service: spawn Xvfb if needed, launch the persistent browser context, start sweep timer.
   * Must be called before any session operations.
   */
  async start(): Promise<void> {
    if (this.context !== null) {
      throw new Error('BrowserService.start() called while already running — call stop() first');
    }

    await this.maybeStartXvfb();
    this.context = await this.contextFactory();

    // Restart the persistent context automatically on disconnect (e.g., OOM kill).
    this.attachDisconnectedHandler(this.context);

    this.sweepTimer = setInterval(() => void this.sweep(), this.sweepIntervalMs);
    this.sweepTimer.unref();

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
      // Intentional shutdown via stop() — do not restart. stop() sets this.stopping
      // before calling context.close() so we can distinguish a deliberate close from
      // an unexpected crash/OOM disconnect.
      if (this.stopping) {
        this.logger.debug('Browser disconnected during stop() — skipping crash-recovery restart');
        return;
      }
      this.logger.error('Playwright browser disconnected — clearing sessions and restarting');
      // Best-effort close of any live sessions before dropping them from the map. On a
      // genuine crash/OOM kill the pages are already gone and these close() calls no-op;
      // but if 'disconnected' fires while the process is still alive (explicit close,
      // transport drop), this prevents leaking the underlying pages/contexts.
      const orphaned = [...this.sessions.values()];
      this.sessions.clear();
      for (const session of orphaned) {
        void session.close().catch(() => { /* browser likely gone — nothing to clean */ });
      }
      void this.contextFactory().then(ctx => {
        this.context = ctx;
        this.attachDisconnectedHandler(ctx);
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

    if (this.context) {
      // Signal the 'disconnected' handler that this disconnect is intentional so it
      // does not trigger crash-recovery (which would try to relaunch the browser while
      // we're tearing down, potentially racing with a restart that reuses the profile).
      this.stopping = true;
      try {
        await this.context.close();
      } catch (err) {
        this.logger.error({ err }, 'Error closing browser context during shutdown');
      } finally {
        // Reset stopping so the instance can be reused after stop() (e.g. in tests)
        // and a future unexpected disconnect still triggers recovery.
        this.stopping = false;
        this.context = null;
      }
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
   * - Expired sessionId → closes the old session, creates a fresh session with a new ID.
   *
   * opts.incognito → isolated ephemeral context off the same browser (no persistent
   * profile). opts.blockAds → attach the (lazily-fetched) Ghostery ad blocker to the page.
   *
   * Returns the session and its (possibly new) sessionId.
   */
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

    // Crash safety: if the page crashes, invalidate the session so the next
    // skill call starts fresh rather than retrying on a broken page.
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

  /**
   * True if a configured browser channel failed to launch and the service degraded to
   * bundled Chromium (a weaker fingerprint than configured). Lets health checks surface
   * the configured-vs-actual divergence rather than leaving it buried in a log line (#987).
   */
  isChannelFallbackActive(): boolean {
    return this.channelFallbackActive;
  }

  // --- Private helpers ---

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
      // Configured-vs-actual divergence: the operator asked for a real browser channel
      // (the whole point of the fingerprint hardening) and we couldn't honour it — almost
      // always a missing browser in the image. Degrade to bundled Chromium so the skill
      // still works, but log at ERROR (not warn): production is now running a materially
      // weaker fingerprint than configured, and that must be loud/alertable, not buried.
      // `channelFallbackActive` exposes the degraded posture for health checks/greppability.
      this.channelFallbackActive = true;
      this.logger.error(
        { err, requestedChannel: this.channel },
        'Browser channel launch failed — DEGRADED to bundled Chromium (weaker fingerprint than configured); is the channel installed in the image?',
      );
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

/**
 * True if `binary` (an executable basename) is an X server: a known server name, or
 * the `X<name>` convention (capital X + lowercase initial, alphanumeric, no separators —
 * so `Xfoo` matches but `Xfce4-session`, `xterm`, and `node` do not).
 */
export function isXServerBinary(binary: string): boolean {
  return X_SERVER_BINARIES.has(binary) || /^X[a-z][A-Za-z0-9]*$/.test(binary);
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
