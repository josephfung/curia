// tests/unit/browser/browser-service-container.test.ts — BrowserService attached to a
// browser container over CDP (#2541): boot without the container, reconnect, disconnect
// on stop, tidy tabs left by a previous run, and resolve the endpoint's hostname.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import pino from 'pino';

const { connectOverCDP } = vi.hoisted(() => ({ connectOverCDP: vi.fn() }));
vi.mock('patchright', () => ({ chromium: { connectOverCDP, launchPersistentContext: vi.fn() } }));
vi.mock('@ghostery/adblocker-playwright', () => ({ PlaywrightBlocker: { fromPrebuiltAdsAndTracking: vi.fn() } }));

import { BrowserService, resolveCdpEndpoint } from '../../../src/browser/browser-service.js';

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
    contexts: vi.fn(),
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

  it('leaves an IP address or localhost as given', async () => {
    const lookup = vi.fn();
    await expect(resolveCdpEndpoint('http://10.0.0.5:9222', lookup)).resolves.toBe('http://10.0.0.5:9222');
    await expect(resolveCdpEndpoint('http://[::1]:9222', lookup)).resolves.toBe('http://[::1]:9222');
    await expect(resolveCdpEndpoint('http://localhost:9222', lookup)).resolves.toBe('http://localhost:9222');
    expect(lookup).not.toHaveBeenCalled();
  });
});
