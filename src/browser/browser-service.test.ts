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
