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
      waitForTimeout: vi.fn().mockResolvedValue(null),
      getByText: vi.fn().mockReturnValue({ click: vi.fn().mockResolvedValue(null), fill: vi.fn().mockResolvedValue(null), count: vi.fn().mockResolvedValue(0) }),
      getByRole: vi.fn().mockReturnValue({ click: vi.fn().mockResolvedValue(null), fill: vi.fn().mockResolvedValue(null), count: vi.fn().mockResolvedValue(0) }),
      getByLabel: vi.fn().mockReturnValue({ click: vi.fn().mockResolvedValue(null), fill: vi.fn().mockResolvedValue(null), count: vi.fn().mockResolvedValue(0) }),
      locator: vi.fn().mockReturnValue({ click: vi.fn().mockResolvedValue(null), fill: vi.fn().mockResolvedValue(null), selectOption: vi.fn().mockResolvedValue(null), count: vi.fn().mockResolvedValue(1) }),
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

  it('navigate: calls getOrCreateSession and returns session_id and content', async () => {
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

  it('click: calls getOrCreateSession with session_id', async () => {
    const result = await handler.execute(makeCtx({ action: 'click', selector: 'Sign up button', session_id: FAKE_SESSION_ID }, mockBrowserService));
    expect(result.success).toBe(true);
    expect(mockBrowserService.getOrCreateSession).toHaveBeenCalledWith(FAKE_SESSION_ID);
  });

  it('type: succeeds with selector and text', async () => {
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
