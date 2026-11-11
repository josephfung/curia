// tests/unit/browser/browser-service-container.test.ts — BrowserService attached to a
// browser container over CDP (#2541): boot without the container, reconnect, disconnect
// on stop, tidy tabs left by a previous run, and resolve the endpoint's hostname.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import pino from 'pino';

const { connectOverCDP } = vi.hoisted(() => ({ connectOverCDP: vi.fn() }));
vi.mock('patchright', () => ({ chromium: { connectOverCDP, launchPersistentContext: vi.fn() } }));
vi.mock('@ghostery/adblocker-playwright', () => ({ PlaywrightBlocker: { fromPrebuiltAdsAndTracking: vi.fn() } }));

import { BrowserService, redactCdpEndpoint, resolveCdpEndpoint, sanitizeCdpError } from '../../../src/browser/browser-service.js';

const logger = pino({ level: 'silent' });
const ENDPOINT = 'http://127.0.0.1:9222';

function makePage() {
  return { on: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
}

function makeBrowser() {
  return {
    isConnected: vi.fn().mockReturnValue(true),
    on: vi.fn(),
    version: vi.fn().mockReturnValue('156.0.8078.4'),
    newContext: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    contexts: vi.fn().mockReturnValue([]),
  };
}

function makeContext(browser: ReturnType<typeof makeBrowser>, pages: ReturnType<typeof makePage>[] = [makePage()]) {
  return {
    newPage: vi.fn().mockImplementation(async () => makePage()),
    close: vi.fn().mockResolvedValue(undefined),
    browser: vi.fn().mockReturnValue(browser),
    pages: vi.fn().mockReturnValue(pages),
  };
}

/** The 'disconnected' listener the service registered on `browser`. */
function disconnectHandler(browser: ReturnType<typeof makeBrowser>): () => void {
  const call = browser.on.mock.calls.find(c => c[0] === 'disconnected');
  expect(call).toBeDefined();
  return call![1] as () => void;
}

describe('BrowserService with a browser container', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    connectOverCDP.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('boots when the container is down, reports no browser, and attaches once it answers', async () => {
    const browser = makeBrowser();
    const context = makeContext(browser);
    const factory = vi.fn()
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
      .mockResolvedValue(context);
    const svc = new BrowserService({ logger, cdpEndpoint: ENDPOINT, contextFactory: factory as never });

    await expect(svc.start()).resolves.toBeUndefined();
    expect(svc.browserContext).toBeNull();
    await expect(svc.getOrCreateSession(undefined)).rejects.toThrow(
      /browser container at http:\/\/127\.0\.0\.1:9222 is not reachable.*docker compose logs browser/,
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(svc.browserContext).toBe(context);
    await expect(svc.getOrCreateSession(undefined)).resolves.toMatchObject({ sessionId: expect.any(String) });

    await svc.stop();
  });

  it('backs off between attempts, up to 30s', async () => {
    const factory = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));
    const svc = new BrowserService({ logger, cdpEndpoint: ENDPOINT, contextFactory: factory as never });
    await svc.start();
    expect(factory).toHaveBeenCalledTimes(1);

    // 1s, 2s, 4s, 8s, 16s, then 30s.
    for (const [delay, calls] of [[1_000, 2], [2_000, 3], [4_000, 4], [8_000, 5], [16_000, 6], [29_999, 6], [1, 7], [30_000, 8]] as const) {
      await vi.advanceTimersByTimeAsync(delay);
      expect(factory).toHaveBeenCalledTimes(calls);
    }
    await svc.stop();
  });

  it('drops the dead context and sessions on disconnect, then reconnects', async () => {
    const first = makeBrowser();
    const second = makeBrowser();
    const firstContext = makeContext(first);
    const secondContext = makeContext(second);
    const factory = vi.fn().mockResolvedValueOnce(firstContext).mockResolvedValue(secondContext);
    const svc = new BrowserService({ logger, cdpEndpoint: ENDPOINT, contextFactory: factory as never });
    await svc.start();
    const { sessionId } = await svc.getOrCreateSession(undefined);

    first.isConnected.mockReturnValue(false);
    disconnectHandler(first)();
    expect(svc.browserContext).toBeNull();
    expect(svc.getSession(sessionId)).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(svc.browserContext).toBe(secondContext);
    // The new browser is watched too, so a second crash also recovers.
    expect(second.on).toHaveBeenCalledWith('disconnected', expect.any(Function));
    await svc.stop();
  });

  it('stop() disconnects without closing the container’s profile, and cancels a pending reconnect', async () => {
    const browser = makeBrowser();
    const context = makeContext(browser);
    const factory = vi.fn().mockResolvedValue(context);
    const svc = new BrowserService({ logger, cdpEndpoint: ENDPOINT, contextFactory: factory as never });
    await svc.start();

    await svc.stop();
    expect(browser.close).toHaveBeenCalledOnce();
    expect(context.close).not.toHaveBeenCalled();

    const down = vi.fn().mockRejectedValue(new Error('down'));
    const svc2 = new BrowserService({ logger, cdpEndpoint: ENDPOINT, contextFactory: down as never });
    await svc2.start();
    await svc2.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(down).toHaveBeenCalledOnce();
  });

  it('disconnects from an attach that completes after stop()', async () => {
    const browser = makeBrowser();
    const context = makeContext(browser);
    let resolveAttach!: (ctx: unknown) => void;
    const factory = vi.fn().mockReturnValue(new Promise(resolve => { resolveAttach = resolve; }));
    const svc = new BrowserService({ logger, cdpEndpoint: ENDPOINT, contextFactory: factory as never });

    const starting = svc.start();
    await svc.stop();
    resolveAttach(context);
    await starting;

    expect(svc.browserContext).toBeNull();
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it('retries when the browser drops while attaching, before its disconnect listener exists', async () => {
    const dead = makeBrowser();
    dead.isConnected.mockReturnValue(false);
    const live = makeBrowser();
    const liveContext = makeContext(live);
    const factory = vi.fn().mockResolvedValueOnce(makeContext(dead)).mockResolvedValue(liveContext);
    const svc = new BrowserService({ logger, cdpEndpoint: ENDPOINT, contextFactory: factory as never });

    await svc.start();
    expect(svc.browserContext).toBeNull();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(svc.browserContext).toBe(liveContext);
    await svc.stop();
  });

  it('discards an attach from before stop() even when start() has run again', async () => {
    const stale = makeBrowser();
    const staleContext = makeContext(stale);
    const fresh = makeBrowser();
    const freshContext = makeContext(fresh);
    let resolveStale!: (ctx: unknown) => void;
    const factory = vi.fn()
      .mockReturnValueOnce(new Promise(resolve => { resolveStale = resolve; }))
      .mockResolvedValue(freshContext);
    const svc = new BrowserService({ logger, cdpEndpoint: ENDPOINT, contextFactory: factory as never });

    const firstStart = svc.start();
    await svc.stop();
    await svc.start();
    resolveStale(staleContext);
    await firstStart;

    expect(svc.browserContext).toBe(freshContext);
    expect(stale.close).toHaveBeenCalledOnce();
    await svc.stop();
  });

  it('does not start a second reconnect loop when an attach from before stop() fails', async () => {
    const fresh = makeBrowser();
    const freshContext = makeContext(fresh);
    let rejectStale!: (err: Error) => void;
    const factory = vi.fn()
      .mockReturnValueOnce(new Promise((_, reject) => { rejectStale = reject; }))
      .mockResolvedValue(freshContext);
    const svc = new BrowserService({ logger, cdpEndpoint: ENDPOINT, contextFactory: factory as never });

    const firstStart = svc.start();
    await svc.stop();
    await svc.start();
    rejectStale(new Error('connect ECONNREFUSED'));
    await firstStart;
    await vi.advanceTimersByTimeAsync(60_000);

    // One attach for the stale generation, one for the current: no timer from the failure.
    expect(factory).toHaveBeenCalledTimes(2);
    expect(svc.browserContext).toBe(freshContext);
    expect(fresh.close).not.toHaveBeenCalled();
    await svc.stop();
  });

  it('gives up on an attach that hangs past its deadline, disconnects it if it lands, and retries', async () => {
    const hung = makeBrowser();
    let resolveHung!: (ctx: unknown) => void;
    const live = makeBrowser();
    const liveContext = makeContext(live);
    const factory = vi.fn()
      .mockReturnValueOnce(new Promise(resolve => { resolveHung = resolve; }))
      .mockResolvedValue(liveContext);
    const svc = new BrowserService({ logger, cdpEndpoint: ENDPOINT, contextFactory: factory as never });

    const starting = svc.start();
    await vi.advanceTimersByTimeAsync(20_000);
    await starting;
    expect(svc.browserContext).toBeNull();
    resolveHung(makeContext(hung));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(hung.close).toHaveBeenCalledOnce();
    expect(svc.browserContext).toBe(liveContext);
    await svc.stop();
  });

  it('refuses a proxy: the container’s Chrome would egress directly', () => {
    expect(() => new BrowserService({ logger, cdpEndpoint: ENDPOINT, proxy: 'http://proxy:8888' }))
      .toThrow(/BROWSER_PROXY/);
  });

  it('closes tabs and incognito contexts a previous run left, keeping the first tab', async () => {
    const browser = makeBrowser();
    const anchor = makePage();
    const staleTab = makePage();
    const context = makeContext(browser, [anchor, staleTab]);
    const staleIncognito = { close: vi.fn().mockResolvedValue(undefined) };
    browser.contexts.mockReturnValue([context, staleIncognito]);
    connectOverCDP.mockResolvedValue(browser);

    const svc = new BrowserService({ logger, cdpEndpoint: ENDPOINT });
    await svc.start();

    expect(connectOverCDP).toHaveBeenCalledWith(ENDPOINT, expect.objectContaining({ timeout: expect.any(Number) }));
    expect(svc.browserContext).toBe(context);
    expect(anchor.close).not.toHaveBeenCalled();
    expect(staleTab.close).toHaveBeenCalledOnce();
    expect(staleIncognito.close).toHaveBeenCalledOnce();
    await svc.stop();
  });

  // A superseded attach (one that outlived its deadline, or one from before stop()) can
  // land after the winner has created sessions. It must not close their tabs or contexts.
  // These drive the real connectOverCDP path (no contextFactory), so a close anywhere in
  // the attach itself, not only in tryAttach, would fail them.
  function sameChrome() {
    const tabs = [makePage()];
    const live = makeBrowser();
    const liveContext = makeContext(live, tabs);
    liveContext.newPage.mockImplementation(async () => { const p = makePage(); tabs.push(p); return p; });
    // Incognito sessions get their own context off the same browser; both connections see it.
    const incognito: ReturnType<typeof makeContext>[] = [];
    live.newContext.mockImplementation(async () => {
      const ctx = makeContext(live, []);
      ctx.newPage.mockImplementation(async () => { const p = makePage(); tabs.push(p); return p; });
      incognito.push(ctx);
      return ctx;
    });
    live.contexts.mockImplementation(() => [liveContext, ...incognito]);
    // The late attach sees the same Chrome: the same tabs and contexts, the winner's included.
    const late = makeBrowser();
    const lateContext = makeContext(late, tabs);
    late.contexts.mockImplementation(() => [lateContext, ...incognito]);
    let resolveLate!: (browser: unknown) => void;
    connectOverCDP
      .mockReturnValueOnce(new Promise(resolve => { resolveLate = resolve; }))
      .mockResolvedValue(live);
    return { tabs, incognito, late, liveContext, landLate: () => resolveLate(late) };
  }

  /** One persistent and one incognito session, each with its own tab. */
  async function openSessions(svc: BrowserService, tabs: unknown[], incognito: unknown[]): Promise<string[]> {
    const persistent = await svc.getOrCreateSession(undefined);
    const isolated = await svc.getOrCreateSession(undefined, { incognito: true });
    expect(tabs).toHaveLength(3);
    expect(incognito).toHaveLength(1);
    return [persistent.sessionId, isolated.sessionId];
  }

  function expectNothingClosed(
    svc: BrowserService,
    sessionIds: string[],
    { tabs, incognito, late }: { tabs: ReturnType<typeof makePage>[]; incognito: ReturnType<typeof makeContext>[]; late: ReturnType<typeof makeBrowser> },
  ): void {
    expect(late.close).toHaveBeenCalledOnce();
    for (const tab of tabs) expect(tab.close).not.toHaveBeenCalled();
    for (const ctx of incognito) expect(ctx.close).not.toHaveBeenCalled();
    for (const id of sessionIds) expect(svc.getSession(id)).toBeDefined();
  }

  it('a timed-out attach that lands after the retry won leaves the live sessions’ tabs open', async () => {
    const chrome = sameChrome();
    const svc = new BrowserService({ logger, cdpEndpoint: ENDPOINT });

    const starting = svc.start();
    await vi.advanceTimersByTimeAsync(20_000);
    await starting;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(connectOverCDP).toHaveBeenCalledTimes(2);
    expect(svc.browserContext).toBe(chrome.liveContext);
    const sessionIds = await openSessions(svc, chrome.tabs, chrome.incognito);

    chrome.landLate();
    await vi.advanceTimersByTimeAsync(0);
    expectNothingClosed(svc, sessionIds, chrome);
    await svc.stop();
  });

  it('an attach from before stop() that lands after start() leaves the live sessions’ tabs open', async () => {
    const chrome = sameChrome();
    const svc = new BrowserService({ logger, cdpEndpoint: ENDPOINT });

    const firstStart = svc.start();
    await svc.stop();
    await svc.start();
    expect(connectOverCDP).toHaveBeenCalledTimes(2);
    expect(svc.browserContext).toBe(chrome.liveContext);
    const sessionIds = await openSessions(svc, chrome.tabs, chrome.incognito);

    chrome.landLate();
    await firstStart;
    await vi.advanceTimersByTimeAsync(0);
    expectNothingClosed(svc, sessionIds, chrome);
    await svc.stop();
  });

  it('treats a browser with no default context as not attached', async () => {
    const browser = makeBrowser();
    browser.contexts.mockReturnValue([]);
    connectOverCDP.mockResolvedValue(browser);

    const svc = new BrowserService({ logger, cdpEndpoint: ENDPOINT });
    await svc.start();
    expect(svc.browserContext).toBeNull();
    expect(browser.close).toHaveBeenCalledOnce();
    await svc.stop();
  });
});

describe('resolveCdpEndpoint', () => {
  it('replaces a hostname with its address, since Chrome refuses a non-IP Host header', async () => {
    const lookup = vi.fn().mockResolvedValue({ address: '172.18.0.3' });
    await expect(resolveCdpEndpoint('http://browser:9222', lookup)).resolves.toBe('http://172.18.0.3:9222/');
    expect(lookup).toHaveBeenCalledWith('browser');
  });

  it('brackets an IPv6 address', async () => {
    const lookup = vi.fn().mockResolvedValue({ address: 'fd00::3' });
    await expect(resolveCdpEndpoint('ws://browser:9222/devtools/browser/x', lookup)).resolves.toBe('ws://[fd00::3]:9222/devtools/browser/x');
  });

  it('refuses a name that resolves to a public address (leaked to outside DNS)', async () => {
    const lookup = vi.fn().mockResolvedValue({ address: '203.0.113.7' });
    await expect(resolveCdpEndpoint('http://browser:9222', lookup)).rejects.toThrow(/public address/);
  });

  it('keeps the hostname of a TLS endpoint, whose certificate names it', async () => {
    const lookup = vi.fn();
    await expect(resolveCdpEndpoint('wss://browser.example.com/devtools?token=x', lookup)).resolves.toBe('wss://browser.example.com/devtools?token=x');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('leaves an IP address or localhost as given', async () => {
    const lookup = vi.fn();
    await expect(resolveCdpEndpoint('http://10.0.0.5:9222', lookup)).resolves.toBe('http://10.0.0.5:9222');
    await expect(resolveCdpEndpoint('http://[::1]:9222', lookup)).resolves.toBe('http://[::1]:9222');
    await expect(resolveCdpEndpoint('http://localhost:9222', lookup)).resolves.toBe('http://localhost:9222');
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe('sanitizeCdpError', () => {
  it('cuts every URL in the message, the derived discovery URL included, back to scheme and host', () => {
    const err = new Error('connect failed: GET https://host.example/json/version/?token=abc 502; ws wss://u:p@host.example/x?t=1');
    const out = sanitizeCdpError(err);
    expect(out).not.toMatch(/token|abc|u:p|\/json|t=1/);
    expect(out).toContain('https://host.example');
  });
  it('accepts a non-Error', () => {
    expect(sanitizeCdpError('http://h:1/?k=v')).toBe('http://h:1');
  });
});

describe('redactCdpEndpoint', () => {
  it('drops credentials, path and query', () => {
    expect(redactCdpEndpoint('wss://user:secret@host.example:443/devtools?token=abc')).toBe('wss://host.example');
    expect(redactCdpEndpoint('http://browser:9222')).toBe('http://browser:9222');
  });
});
