// Handler-level tests for the adaptive settle (#2244) and clear_site_data. Fake timers
// drive real settle timings, so the fixtures' multi-second redirect chains run instantly.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// Name resolution for the private-address guard (#2521): every name resolves to a public
// address unless a test maps it to another through `dnsAnswers`.
const dnsAnswers = vi.hoisted(() => new Map<string, string>());
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (hostname: string) => [{ address: dnsAnswers.get(hostname) ?? '93.184.215.14', family: 4 }]),
}));

vi.mock('../../../../src/browser/human-behavior.js', () => ({
  jitteredDelay: vi.fn().mockResolvedValue(undefined),
  simulateHumanPresence: vi.fn().mockResolvedValue(undefined),
  humanClick: vi.fn().mockResolvedValue(undefined),
  humanFocusField: vi.fn().mockResolvedValue(undefined),
  humanType: vi.fn().mockResolvedValue(undefined),
}));

import pino from 'pino';
import type { BrowserContext, Page } from 'playwright';
import { WebBrowserHandler } from './handler.js';
import { jitteredDelay } from '../../../../src/browser/human-behavior.js';
import { probeFrameContent, type FrameProbe } from './settle-probe.js';
import { BrowserSession } from '../../../../src/browser/browser-session.js';
import type { BrowserService } from '../../../../src/browser/browser-service.js';
import type { ToolContext, ToolResult } from '../../../../src/skills/types.js';

const logger = pino({ level: 'silent' });

const BLANK: FrameProbe = { textChars: 0, labelledControls: 0, credentialFields: 0 };
const CONTENT: FrameProbe = { textChars: 2_000, labelledControls: 40, credentialFields: 0 };
const LOGIN_FORM: FrameProbe = { textChars: 300, labelledControls: 4, credentialFields: 2 };

/** One state of the page from `at` ms after the clock it is relative to. */
interface Stage { at: number; url: string; probe: FrameProbe; content: string }

/**
 * A page that follows a timeline of stages by the (fake) clock. `startTimeline` restarts
 * the clock with new stages, which is how a key press "submits" the form. Emits
 * framenavigated on each URL change it reports, and request events when told to.
 */
function timelinePage(initial: Stage[]) {
  const emitter = new EventEmitter();
  let stages = initial;
  let t0 = Date.now();
  let lastUrl = initial[0]!.url;
  const current = (): Stage => [...stages].reverse().find((s) => Date.now() - t0 >= s.at) ?? stages[0]!;
  const readFailures = { remaining: 0 };

  const mainFrame = {
    url: () => current().url,
    name: () => '',
    evaluate: vi.fn(async (fn: unknown) => {
      if (fn === probeFrameContent) return current().probe;
      if (readFailures.remaining > 0) {
        readFailures.remaining--;
        throw new Error('Execution context was destroyed, most likely because of a navigation');
      }
      return current().content;
    }),
  };
  const locator = {
    count: vi.fn().mockResolvedValue(1),
    first: vi.fn().mockReturnThis(),
    nth: vi.fn().mockReturnThis(),
    isVisible: vi.fn().mockResolvedValue(true),
    locator: vi.fn().mockReturnThis(),
  };
  const page = {
    url: () => {
      const url = current().url;
      if (url !== lastUrl) {
        lastUrl = url;
        emitter.emit('framenavigated', mainFrame);
      }
      return url;
    },
    mainFrame: () => mainFrame,
    frames: () => [mainFrame],
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    goto: vi.fn(async (url: string) => {
      t0 = Date.now();
      stages = stages.map((s, i) => (i === 0 ? { ...s, url } : s));
      return { status: () => 200 };
    }),
    title: vi.fn().mockResolvedValue(''),
    // isLikelyEmpty's metrics: an SPA shell (plenty of HTML), so never mistaken for a block stub.
    evaluate: vi.fn().mockResolvedValue({ textLength: 0, htmlLength: 50_000, interactiveCount: 0 }),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    reload: vi.fn().mockResolvedValue({ status: () => 200 }),
    keyboard: { press: vi.fn().mockResolvedValue(undefined) },
    getByRole: vi.fn().mockReturnValue(locator),
    getByLabel: vi.fn().mockReturnValue(locator),
    getByText: vi.fn().mockReturnValue(locator),
    locator: vi.fn().mockReturnValue(locator),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('png')),
  };
  const startTimeline = (next: Stage[]): void => {
    stages = next;
    t0 = Date.now();
  };
  return { page, emitter, mainFrame, startTimeline, readFailures };
}

function contextFor(page: unknown, input: Record<string, unknown>, extra: Partial<BrowserService> = {}) {
  const session = new BrowserSession({} as unknown as BrowserContext, page as Page);
  const browserService = {
    getOrCreateSession: vi.fn().mockResolvedValue({ sessionId: 'sess-settle', session }),
    closeSession: vi.fn().mockResolvedValue(undefined),
    ...extra,
  } as unknown as BrowserService;
  const ctx = { input, log: logger, browserService } as unknown as ToolContext;
  return { ctx, session };
}

/** Run the handler while advancing fake time until it finishes. */
async function runToCompletion(ctx: ToolContext): Promise<ToolResult> {
  let done = false;
  const pending = new WebBrowserHandler().execute(ctx).finally(() => { done = true; });
  for (let i = 0; i < 2_000 && !done; i++) await vi.advanceTimersByTimeAsync(100);
  return pending;
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-10-22T15:14:00Z') });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('web-browser adaptive settle (#2244)', () => {
  it('navigate returns an ordinary page at once, settled, with no redirect chain', async () => {
    const { page, mainFrame } = timelinePage([
      { at: 0, url: 'https://news.example.com/', probe: CONTENT, content: 'Top stories today' },
    ]);
    const { ctx } = contextFor(page, { action: 'navigate', url: 'https://news.example.com/' });
    // The real post-load dwell is 2-4s; it covers the quiet window after goto commits.
    vi.mocked(jitteredDelay).mockImplementationOnce(() => new Promise((r) => setTimeout(r, 2_000)));
    const start = Date.now();

    const result = await runToCompletion(ctx);

    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data as Record<string, unknown>;
    expect(data.settled).toBe(true);
    expect(data.redirect_chain).toBeUndefined();
    expect(data.content).toContain('Top stories today');
    // One probe and no polling: the fast path adds no wait beyond the existing dwell.
    expect(mainFrame.evaluate.mock.calls.filter(([fn]) => fn === probeFrameContent)).toHaveLength(1);
    expect(Date.now() - start).toBeLessThanOrEqual(2_100);
  });

  // The fixture from the acceptance criteria.
  it('navigate follows two blank JS-redirect hops and a >5s gap to the form, settled', async () => {
    const { page } = timelinePage([
      { at: 0, url: 'https://sso.example.com/start', probe: BLANK, content: '' },
      { at: 1_000, url: 'https://sso.example.com/hop?context=abc', probe: BLANK, content: '' },
      { at: 7_000, url: 'https://sso.example.com/login', probe: BLANK, content: '' },
      { at: 7_500, url: 'https://sso.example.com/login', probe: LOGIN_FORM, content: 'Sign in\n[g1f0e1] textbox "Email"' },
    ]);
    const { ctx } = contextFor(page, { action: 'navigate', url: 'https://sso.example.com/start' });

    const result = await runToCompletion(ctx);

    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data as Record<string, unknown>;
    expect(data.settled).toBe(true);
    expect(data.url).toBe('https://sso.example.com/login');
    expect(data.content).toContain('textbox "Email"');
    expect(data.redirect_chain).toEqual([
      'https://sso.example.com/start',
      'https://sso.example.com/hop?context=redacted',
      'https://sso.example.com/login',
    ]);
  });

  // The 2026-10-22 failure: the code was submitted with Enter inside a batch, the code
  // check is an XHR, and the redirect through the post-consent handoff followed it.
  it('a batch that submits with Enter returns the post-redirect page', async () => {
    const { page, emitter, mainFrame, startTimeline } = timelinePage([
      { at: 0, url: 'https://www.aircanada.com/clogin/pages/verify', probe: LOGIN_FORM, content: 'Enter the code we emailed you' },
    ]);
    page.keyboard.press.mockImplementation(async (key: string) => {
      if (key !== 'Enter') return;
      const xhr = { isNavigationRequest: () => false, frame: () => mainFrame, resourceType: () => 'fetch' };
      emitter.emit('request', xhr);
      setTimeout(() => {
        emitter.emit('requestfinished', xhr);
        emitter.emit('request', { isNavigationRequest: () => true, frame: () => mainFrame, resourceType: () => 'document' });
        startTimeline([
          { at: 0, url: 'https://www.aircanada.com/clogin/pages/proxy?mode=afterConsent&consent=UID123', probe: BLANK, content: '' },
          { at: 6_000, url: 'https://www.aircanada.com/callback?code=GRANT&state=s1', probe: BLANK, content: '' },
          { at: 7_000, url: 'https://www.aircanada.com/ca/en/aco/home.html', probe: CONTENT, content: 'Welcome back, Jordan · 12,345 points' },
        ]);
      }, 1_000);
    });
    const { ctx } = contextFor(page, {
      actions: [
        { action: 'type', selector: 'Verification code', text: '482913' },
        { action: 'press_key', key: 'Enter' },
      ],
    });

    const result = await runToCompletion(ctx);

    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data as Record<string, unknown>;
    expect(data.actions_completed).toBe(2);
    expect(data.settled).toBe(true);
    expect(data.url).toBe('https://www.aircanada.com/ca/en/aco/home.html');
    expect(data.content).toContain('Welcome back');
    const chain = data.redirect_chain as string[];
    expect(chain[0]).toBe('https://www.aircanada.com/clogin/pages/verify');
    expect(chain.at(-1)).toBe('https://www.aircanada.com/ca/en/aco/home.html');
    expect(chain.join(' ')).not.toContain('GRANT');
    expect(chain.join(' ')).not.toContain('UID123');
  });

  it('a navigating step settles before the next step runs', async () => {
    const { page } = timelinePage([
      { at: 0, url: 'https://sso.example.com/start', probe: BLANK, content: '' },
      { at: 3_000, url: 'https://sso.example.com/login', probe: LOGIN_FORM, content: 'Sign in' },
    ]);
    const urlsAtType: string[] = [];
    page.getByRole.mockImplementation(() => {
      urlsAtType.push(page.url());
      return { count: vi.fn().mockResolvedValue(1), first: vi.fn().mockReturnThis(), nth: vi.fn().mockReturnThis(), isVisible: vi.fn().mockResolvedValue(true), locator: vi.fn().mockReturnThis() };
    });
    const { ctx } = contextFor(page, {
      actions: [
        { action: 'navigate', url: 'https://sso.example.com/start' },
        { action: 'type', selector: 'Email', text: 'jordan@example.com' },
      ],
    });

    const result = await runToCompletion(ctx);

    expect(result.success).toBe(true);
    expect(urlsAtType[0]).toBe('https://sso.example.com/login');
  });

  it('a read that fails mid-navigation is retried after the page settles', async () => {
    const { page, readFailures } = timelinePage([
      { at: 0, url: 'https://a.example.com/next', probe: CONTENT, content: 'The settled page' },
    ]);
    readFailures.remaining = 1;
    const { ctx } = contextFor(page, { action: 'get_content' });

    const result = await runToCompletion(ctx);

    expect(result.success).toBe(true);
    if (result.success) expect((result.data as Record<string, unknown>).content).toContain('The settled page');
  });

  it('a read that still fails once settled is returned as an error', async () => {
    const { page, readFailures } = timelinePage([
      { at: 0, url: 'https://a.example.com/', probe: CONTENT, content: 'never read' },
    ]);
    readFailures.remaining = 2;
    const { ctx } = contextFor(page, { action: 'get_content' });

    const result = await runToCompletion(ctx);

    expect(result).toEqual({ success: false, error: expect.stringContaining('all frames errored during extraction') });
  });

  it('a page still blank at the cap is returned unsettled, with console errors and a wait_for hint', async () => {
    const { page } = timelinePage([
      { at: 0, url: 'https://a.example.com/redirecting', probe: BLANK, content: '' },
    ]);
    const { ctx, session } = contextFor(page, { action: 'navigate', url: 'https://a.example.com/redirecting' }, { settleCapMs: 10_000 } as Partial<BrowserService>);
    session.recordConsoleError('Failed to load resource: the server responded with a status of 500 ()');
    const start = Date.now();

    const result = await runToCompletion(ctx);

    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data as Record<string, unknown>;
    expect(data.settled).toBe(false);
    expect(Date.now() - start).toBeGreaterThanOrEqual(10_000);
    expect(data.content).toContain('wait_for');
    expect(data.content).not.toContain('half-signed-in');
    expect(data.console_errors).toEqual(['Failed to load resource: the server responded with a status of 500 ()']);
  });

  // Review fix: a redirect to a Google file that lands while the page settles is refused,
  // not read.
  it('refuses a Google file reached while settling', async () => {
    const { page, mainFrame } = timelinePage([
      { at: 0, url: 'https://interstitial.example.com/go', probe: BLANK, content: '' },
      { at: 3_000, url: 'https://docs.google.com/document/d/abc123/edit', probe: CONTENT, content: 'secret doc' },
    ]);
    const { ctx } = contextFor(page, { action: 'navigate', url: 'https://interstitial.example.com/go' });

    const result = await runToCompletion(ctx);

    expect(result).toEqual({ success: false, error: expect.stringContaining('Google') });
    expect(mainFrame.evaluate.mock.calls.some(([fn]) => fn !== probeFrameContent)).toBe(false);
  });

  it('a stuck sign-in handoff says navigating away aborts the sign-in', async () => {
    const { page } = timelinePage([
      { at: 0, url: 'https://www.aircanada.com/clogin/pages/consent', probe: BLANK, content: '' },
    ]);
    const { ctx } = contextFor(page, { action: 'get_content' }, { settleCapMs: 5_000 } as Partial<BrowserService>);

    const result = await runToCompletion(ctx);

    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data as Record<string, unknown>;
    expect(data.settled).toBe(false);
    expect(data.content).toContain('sign-in handoff');
    expect(data.content).toContain('half-signed-in');
    expect(data.content).toContain('wait_for');
    expect(data.console_errors).toBeUndefined();
  });

  it('console errors are left out of a settled page with content', async () => {
    const { page } = timelinePage([{ at: 0, url: 'https://a.example.com/', probe: CONTENT, content: 'Hello' }]);
    const { ctx, session } = contextFor(page, { action: 'get_content' });
    session.recordConsoleError('Failed to load resource: net::ERR_BLOCKED_BY_CLIENT');

    const result = await runToCompletion(ctx);

    expect(result.success).toBe(true);
    if (result.success) expect((result.data as Record<string, unknown>).console_errors).toBeUndefined();
  });

  it('a click that does not navigate is not held', async () => {
    const { page } = timelinePage([{ at: 0, url: 'https://a.example.com/survey', probe: CONTENT, content: 'Q1' }]);
    const { ctx } = contextFor(page, { action: 'click', selector: 'Agree' });
    const start = Date.now();

    const result = await runToCompletion(ctx);

    expect(result.success).toBe(true);
    if (result.success) expect((result.data as Record<string, unknown>).settled).toBe(true);
    // Only the short grace window for a navigation to start.
    expect(Date.now() - start).toBeLessThanOrEqual(500);
  });
});

describe('web-browser clear_site_data (#2244)', () => {
  /** A context with a real-enough cookie jar: clearCookies removes the exact cookie named. */
  function fakeContext(cookieDomains: string[], frameUrl = 'https://www.aircanada.com/clogin/pages/consent') {
    let cookies = cookieDomains.map((domain, i) => ({ name: `c${i}`, value: 'v', domain, path: '/' }));
    const sent: Array<{ method: string; params: unknown }> = [];
    const cdp = {
      send: vi.fn(async (method: string, params: unknown) => { sent.push({ method, params }); return {}; }),
      detach: vi.fn().mockResolvedValue(undefined),
    };
    const frameOnHost = { url: () => frameUrl, evaluate: vi.fn().mockResolvedValue(undefined) };
    const context = {
      cookies: vi.fn(async () => cookies),
      clearCookies: vi.fn(async (filter: { name: string; domain: string; path: string }) => {
        cookies = cookies.filter((c) => !(c.name === filter.name && c.domain === filter.domain && c.path === filter.path));
      }),
      pages: () => [{ frames: () => [frameOnHost, { url: () => 'https://www.linkedin.com/feed' }] }],
      newCDPSession: vi.fn().mockResolvedValue(cdp),
    };
    const origins = (): string[] => sent.map((s) => (s.params as { origin: string }).origin);
    return { context, sent, origins, remaining: () => cookies.map((c) => c.domain), frameOnHost };
  }

  function clearCtx(input: Record<string, unknown>, context: unknown) {
    const page = { url: () => 'about:blank', mainFrame: () => ({}), frames: () => [] };
    const session = new BrowserSession(context as BrowserContext, page as unknown as Page);
    const browserService = {
      getOrCreateSession: vi.fn().mockResolvedValue({ sessionId: 'sess-clear', session }),
    } as unknown as BrowserService;
    return { input, log: logger, browserService } as unknown as ToolContext;
  }

  const AIR_CANADA_JAR = ['.aircanada.com', 'www.aircanada.com', 'accounts.aircanada.com', 'aircanada.com', '.linkedin.com', 'www.manulife.ca', '.notaircanada.com'];

  // The recovery case: the stuck page is on www.aircanada.com; the half-signed-in state sits
  // on the parent .aircanada.com domain cookie the browser sends there.
  it('clears what the host can see and leaves other sites signed in', async () => {
    const jar = fakeContext(AIR_CANADA_JAR);

    const result = await new WebBrowserHandler().execute(clearCtx({ action: 'clear_site_data', domain: 'www.aircanada.com' }, jar.context));

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect((result.data as Record<string, unknown>).cleared).toMatchObject({ host: 'www.aircanada.com', cookies: 2 });
    // A sibling host's cookie and the parent's host-only cookie are not sent to www, so they stay.
    expect(jar.remaining()).toEqual(['accounts.aircanada.com', 'aircanada.com', '.linkedin.com', 'www.manulife.ca', '.notaircanada.com']);
    expect(jar.origins()).toEqual(['https://www.aircanada.com', 'http://www.aircanada.com']);
    expect(jar.sent.every((s) => s.method === 'Storage.clearDataForOrigin')).toBe(true);
    expect(jar.frameOnHost.evaluate).toHaveBeenCalledWith('sessionStorage.clear()');
  });

  it('clears the whole site when given the bare domain', async () => {
    const jar = fakeContext(AIR_CANADA_JAR);

    await new WebBrowserHandler().execute(clearCtx({ action: 'clear_site_data', domain: 'aircanada.com' }, jar.context));

    expect(jar.remaining()).toEqual(['.linkedin.com', 'www.manulife.ca', '.notaircanada.com']);
    expect(jar.origins()).toEqual(expect.arrayContaining(['https://aircanada.com', 'https://www.aircanada.com', 'https://accounts.aircanada.com']));
    expect(jar.origins().some((o) => /linkedin|manulife|notaircanada/.test(o))).toBe(false);
  });

  // No list of shared hosts: a tenant host only sees its own cookies and the shared
  // parent-domain ones, so other tenants stay signed in (PR #2259 review).
  it.each([
    ['acme.okta.com', ['acme.okta.com', 'other.okta.com', '.okta.com'], ['other.okta.com']],
    ['https://acme.us.auth0.com/u/login', ['acme.us.auth0.com', 'other.us.auth0.com'], ['other.us.auth0.com']],
    ['manulife.b2clogin.com', ['manulife.b2clogin.com', 'contoso.b2clogin.com'], ['contoso.b2clogin.com']],
    ['acme.github.io', ['acme.github.io', 'other.github.io'], ['other.github.io']],
  ])('clearing tenant %s leaves the other tenants signed in', async (domain, jarDomains, left) => {
    const jar = fakeContext(jarDomains, 'https://www.linkedin.com/');
    const result = await new WebBrowserHandler().execute(clearCtx({ action: 'clear_site_data', domain }, jar.context));
    expect(result.success).toBe(true);
    expect(jar.remaining()).toEqual(left);
  });

  it('requires a domain', async () => {
    const jar = fakeContext([]);
    expect(await new WebBrowserHandler().execute(clearCtx({ action: 'clear_site_data' }, jar.context)))
      .toEqual({ success: false, error: expect.stringContaining('requires domain') });
  });

  it.each(['10.0.0.1', 'com', 'not a domain', ''])('rejects %j as a domain', async (domain) => {
    const jar = fakeContext(['.aircanada.com']);
    const result = await new WebBrowserHandler().execute(clearCtx({ action: 'clear_site_data', domain }, jar.context));
    expect(result.success).toBe(false);
    expect(jar.context.clearCookies).not.toHaveBeenCalled();
  });

  it('is refused inside a batch', async () => {
    const jar = fakeContext(['.aircanada.com']);
    const result = await new WebBrowserHandler().execute(
      clearCtx({ actions: [{ action: 'get_content' }, { action: 'clear_site_data', domain: 'aircanada.com' }] }, jar.context),
    );
    expect(result).toEqual({ success: false, error: expect.stringContaining('clear_site_data cannot be used inside a batch') });
    expect(jar.context.clearCookies).not.toHaveBeenCalled();
  });
});
