// src/browser/browser-service.test.ts — BrowserService unit tests (mocked Playwright)
// and integration tests (real browser, gated behind RUN_BROWSER_TESTS=1).
//
// Unit tests inject a fake browser factory so no real Playwright process is needed.
// Integration tests spin up a real Chromium instance — run them with:
//   RUN_BROWSER_TESTS=1 pnpm test src/browser/browser-service.test.ts

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserService, clearStaleX11Lock } from './browser-service.js';
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

  // Isolate unit tests from the host display environment.
  // BrowserService.start() calls maybeStartXvfb() which spawns Xvfb on Linux
  // when DISPLAY is unset — even when a fake browserFactory is injected. Setting
  // DISPLAY here prevents that spawn so the unit suite works on bare Linux CI
  // images that don't have Xvfb installed. We restore the original value (or
  // delete it) in afterEach to avoid cross-test pollution.
  let savedDisplay: string | undefined;

  beforeEach(async () => {
    savedDisplay = process.env.DISPLAY;
    process.env.DISPLAY = savedDisplay ?? ':99';

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
    if (savedDisplay === undefined) {
      delete process.env.DISPLAY;
    } else {
      process.env.DISPLAY = savedDisplay;
    }
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

// --- clearStaleX11Lock (stale Xvfb lock cleanup) ---

describe('clearStaleX11Lock', () => {
  let dir: string;       // fake tmp dir standing in for /tmp
  let lockPath: string;  // fake /tmp/.X99-lock
  let socketPath: string; // fake /tmp/.X11-unix/X99

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'xvfb-lock-test-'));
    mkdirSync(join(dir, '.X11-unix'), { recursive: true });
    lockPath = join(dir, '.X99-lock');
    socketPath = join(dir, '.X11-unix', 'X99');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('removes a stale lock + socket when no live process owns the display', () => {
    // X servers write the owning PID left-padded to 10 chars with a trailing newline.
    writeFileSync(lockPath, '      4242\n');
    writeFileSync(socketPath, '');

    const removed = clearStaleX11Lock({
      displayNum: 99,
      tmpDir: dir,
      // Owning PID is dead — this is the crash-leftover case from the issue.
      isProcessAlive: () => false,
      logger,
    });

    expect(removed).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(socketPath)).toBe(false);
  });

  it('leaves the lock + socket intact when a live X server owns the display', () => {
    writeFileSync(lockPath, '      4242\n');
    writeFileSync(socketPath, '');

    const removed = clearStaleX11Lock({
      displayNum: 99,
      tmpDir: dir,
      // A genuinely live owner must never be clobbered.
      isProcessAlive: () => true,
      logger,
    });

    expect(removed).toBe(false);
    expect(existsSync(lockPath)).toBe(true);
    expect(existsSync(socketPath)).toBe(true);
  });

  it('treats an unparseable lock as stale and removes it (liveness check is skipped)', () => {
    writeFileSync(lockPath, 'not-a-pid\n');
    const aliveCheck = vi.fn().mockReturnValue(true);

    const removed = clearStaleX11Lock({ displayNum: 99, tmpDir: dir, isProcessAlive: aliveCheck, logger });

    expect(removed).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
    // No PID to check, so the liveness probe should never run.
    expect(aliveCheck).not.toHaveBeenCalled();
  });

  it('is a no-op when no lock or socket is present', () => {
    const removed = clearStaleX11Lock({
      displayNum: 99,
      tmpDir: dir,
      isProcessAlive: () => false,
      logger,
    });
    expect(removed).toBe(false);
  });

  it('leaves a lockless socket untouched — no PID means ownership cannot be proven', () => {
    // Socket present but no lock file. Without a recorded PID we can't prove the
    // display is free, so we must not remove it (could clobber a live server). A
    // genuinely stale lockless socket is harmless — the X server recreates it.
    writeFileSync(socketPath, '');
    const aliveCheck = vi.fn().mockReturnValue(false);

    const removed = clearStaleX11Lock({ displayNum: 99, tmpDir: dir, isProcessAlive: aliveCheck, logger });

    expect(removed).toBe(false);
    expect(existsSync(socketPath)).toBe(true);
    expect(aliveCheck).not.toHaveBeenCalled();
  });
});

// --- Integration tests (real browser) ---

// Explicit '1' comparison — treats "0" and "false" as disabled, not truthy-coerced.
const runBrowserTests = process.env.RUN_BROWSER_TESTS === '1';

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

  it('full flow: navigate → get cleaned content → close_session', async () => {
    const { sessionId, session } = await service.getOrCreateSession(undefined);

    // Navigate to a known, stable page
    await session.page.goto('https://example.com', { waitUntil: 'domcontentloaded' });

    // Run the same DOM-cleaning evaluate() that the handler uses.
    // Clone the body before stripping so we don't permanently mutate the live DOM —
    // this mirrors the fix applied to getCleanedContent() in the handler.
    //
    // page.evaluate() callbacks run inside the browser — DOM globals (document,
    // HTMLBodyElement, etc.) exist at runtime but aren't in this project's server
    // tsconfig lib. Access them via `globalThis` to satisfy the type-checker without
    // adding "dom" to the lib (which would pollute the server-side type surface).
    const content = await session.page.evaluate((): string => {
      type AnyEl = { remove(): void; querySelectorAll(s: string): ArrayLike<AnyEl>; innerText?: string; textContent?: string | null };
      type Win = { document?: { body?: { cloneNode(deep: boolean): AnyEl | null } } };
      const win = globalThis as unknown as Win;
      const root = win.document?.body?.cloneNode(true) ?? null;
      if (!root) return '';
      const noiseSelectors = ['script', 'style', 'noscript', 'svg', 'iframe', 'template'];
      for (const sel of noiseSelectors) {
        Array.from(root.querySelectorAll(sel)).forEach((el) => el.remove());
      }
      return (root.innerText ?? root.textContent ?? '').trim();
    });

    // example.com is a real, stable page with known content
    expect(content).toContain('Example Domain');
    expect(content).not.toContain('<script>');

    // Explicitly close and confirm the session is gone
    await service.closeSession(sessionId);
    expect(service.getSession(sessionId)).toBeUndefined();
  });
});
