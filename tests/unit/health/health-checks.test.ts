import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  checkDb,
  checkBus,
  checkBrowser,
  checkEmail,
  checkScheduler,
  checkSignal,
  checkSlack,
  checkSms,
  checkVoice,
  withTimeout,
} from '../../../src/health/health-checks.js';
import type { Logger } from '../../../src/logger.js';

// Stub logger — the probe functions (checkDb, checkSignal, checkMcpServers, ...)
// require a logger to warn on failure. Tests that don't care about log output pass this.
const stubLogger = { warn: () => {} } as unknown as Logger;

describe('checkDb', () => {
  it('returns ok when SELECT 1 succeeds', async () => {
    const pool = { query: vi.fn().mockResolvedValue({}) } as never;
    expect(await checkDb(pool, stubLogger)).toBe('ok');
  });

  it('returns fail when query throws', async () => {
    const pool = { query: vi.fn().mockRejectedValue(new Error('connection refused')) } as never;
    expect(await checkDb(pool, stubLogger)).toBe('fail');
  });
});

// #1762. This check used to be `browserContext !== null` — an object-reference
// existence test. Chrome is out-of-process, so a reference proves nothing about the
// process behind it; that is the same shape that let a dead PulseAudio daemon read as
// healthy (#1760). It now round-trips to the browser.
describe('checkBrowser', () => {
  /** A context whose cookies() resolves — stands in for a live browser. */
  const live = { browserContext: { cookies: vi.fn().mockResolvedValue([]) } };

  it('returns skipped when no service provided', async () => {
    expect(await checkBrowser(undefined, stubLogger)).toBe('skipped');
  });

  it('returns ok when the browser answers the round-trip', async () => {
    expect(await checkBrowser(live, stubLogger)).toBe('ok');
  });

  it('returns fail when browserContext is null (service stopped or relaunch failed)', async () => {
    expect(await checkBrowser({ browserContext: null }, stubLogger)).toBe('fail');
  });

  it('returns fail when the browser is gone but the context reference survives', async () => {
    // THE case the old check could not see. Playwright throws "Target closed" /
    // "Browser has been closed" once the process dies; BrowserService only nulls its
    // reference if crash recovery runs AND its relaunch fails, so between the crash
    // and that point the reference is a live object pointing at a corpse.
    const dead = {
      browserContext: { cookies: vi.fn().mockRejectedValue(new Error('Target page, context or browser has been closed')) },
    };
    expect(await checkBrowser(dead, stubLogger)).toBe('fail');
  });

  it('returns fail when the browser is wedged rather than dead', async () => {
    // A hung renderer keeps the transport open, so isConnected() — what the
    // browserContext getter's comment claimed this probe used — still reports true.
    // Only a bounded round-trip catches it. Unlike a Unix-socket connect, a hang is
    // deterministically reproducible here because the mock never settles.
    const wedged = { browserContext: { cookies: vi.fn().mockReturnValue(new Promise(() => {})) } };
    expect(await checkBrowser(wedged, stubLogger, 10)).toBe('fail');
  });

  it('scopes the cookie read to one URL rather than dumping the whole jar', async () => {
    // The persistent profile is a real browsing profile. Reading every cookie every 30s
    // to answer "is it alive?" pulls session tokens into memory for no reason; a single
    // narrow URL is the same round-trip with none of that.
    const spy = vi.fn().mockResolvedValue([]);
    await checkBrowser({ browserContext: { cookies: spy } }, stubLogger);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toBeTruthy();
  });
});

// PR #1763 review. `Promise.race([work, timeoutPromise])` does NOT cancel the losing
// timer: when `work` wins, the setTimeout stays scheduled until it fires. Every racing
// probe in this module used that pattern, and /api/health is hit every 30s by the
// Docker healthcheck, so each request left a handful of timers pending. Individually
// harmless; collectively the same slow-accumulation shape as the Ajv leak that
// OOM-restarted prod (#1663). These tests pin the fix at both levels.
describe('withTimeout', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('clears the losing timer when the work settles first', async () => {
    vi.useFakeTimers();
    await withTimeout(Promise.resolve('done'), 5_000);
    // Without the clearTimeout this is 1 — the old behaviour, once per probe per request.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns the work result untouched', async () => {
    expect(await withTimeout(Promise.resolve('value'), 1_000)).toBe('value');
  });

  it('rejects when the work outlives the budget', async () => {
    await expect(withTimeout(new Promise(() => {}), 5)).rejects.toThrow('timeout');
  });

  it('propagates the work rejection rather than masking it as a timeout', async () => {
    // A probe that reports every failure as "timeout" loses the actual cause in the log.
    await expect(withTimeout(Promise.reject(new Error('ECONNREFUSED')), 5_000))
      .rejects.toThrow('ECONNREFUSED');
  });

  it('leaves no timer pending after the work rejects', async () => {
    vi.useFakeTimers();
    await expect(withTimeout(Promise.reject(new Error('boom')), 5_000)).rejects.toThrow('boom');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('probe timer hygiene (PR #1763 review)', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('leaves no timer pending after a successful checkBrowser probe', async () => {
    vi.useFakeTimers();
    const svc = { browserContext: { cookies: vi.fn().mockResolvedValue([]) } };
    expect(await checkBrowser(svc, stubLogger)).toBe('ok');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves no timer pending after a successful checkSignal probe', async () => {
    // Same pattern, pre-existing. Fixing only the function under review would have left
    // four known instances behind and made the new one the odd style out.
    vi.useFakeTimers();
    expect(await checkSignal({ listGroups: vi.fn().mockResolvedValue([]) }, stubLogger)).toBe('ok');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves no timer pending after a successful checkVoice probe', async () => {
    vi.useFakeTimers();
    expect(await checkVoice({ listRooms: vi.fn().mockResolvedValue([]) }, stubLogger)).toBe('ok');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('checkBus', () => {
  it('returns ok when bus has listeners', () => {
    const bus = { listenerCount: vi.fn().mockReturnValue(3) } as never;
    expect(checkBus(bus)).toBe('ok');
  });

  it('returns fail when bus has no listeners', () => {
    const bus = { listenerCount: vi.fn().mockReturnValue(0) } as never;
    expect(checkBus(bus)).toBe('fail');
  });
});

describe('checkEmail', () => {
  const startedAt = new Date(Date.now() - 60_000); // 60s ago

  it('returns skipped when no adapter provided', () => {
    expect(checkEmail(undefined, 3, startedAt)).toBe('skipped');
  });

  it('returns ok within grace window when lastSuccessfulPollAt is null', () => {
    const recentStart = new Date(Date.now() - 1000); // 1s ago
    const adapter = { lastSuccessfulPollAt: null, pollingIntervalMs: 60_000 } as never;
    expect(checkEmail(adapter, 3, recentStart)).toBe('ok');
  });

  it('returns fail when null past grace window', () => {
    const oldStart = new Date(Date.now() - 300_000); // 5min ago, grace = 3×60s = 3min
    const adapter = { lastSuccessfulPollAt: null, pollingIntervalMs: 60_000 } as never;
    expect(checkEmail(adapter, 3, oldStart)).toBe('fail');
  });

  it('returns ok when last poll is recent', () => {
    const adapter = {
      lastSuccessfulPollAt: new Date(Date.now() - 30_000), // 30s ago
      pollingIntervalMs: 60_000,
    } as never;
    expect(checkEmail(adapter, 3, startedAt)).toBe('ok');
  });

  it('returns fail when last poll is stale', () => {
    const adapter = {
      lastSuccessfulPollAt: new Date(Date.now() - 300_000), // 5min ago, threshold = 3×60s = 3min
      pollingIntervalMs: 60_000,
    } as never;
    expect(checkEmail(adapter, 3, startedAt)).toBe('fail');
  });
});

describe('checkScheduler', () => {
  it('returns ok within grace window when lastTickAt is null', () => {
    const recentStart = new Date(Date.now() - 5_000);
    const scheduler = { lastTickAt: null } as never;
    expect(checkScheduler(scheduler, 120, recentStart)).toBe('ok');
  });

  it('returns fail when null past grace window', () => {
    const oldStart = new Date(Date.now() - 300_000);
    const scheduler = { lastTickAt: null } as never;
    expect(checkScheduler(scheduler, 120, oldStart)).toBe('fail');
  });

  it('returns ok when last tick is recent', () => {
    const scheduler = { lastTickAt: new Date(Date.now() - 60_000) } as never;
    expect(checkScheduler(scheduler, 120, new Date(0))).toBe('ok');
  });

  it('returns fail when last tick is stale', () => {
    const scheduler = { lastTickAt: new Date(Date.now() - 300_000) } as never;
    expect(checkScheduler(scheduler, 120, new Date(0))).toBe('fail');
  });
});

describe('checkSlack (#1567)', () => {
  it('returns skipped when Slack is not configured', () => {
    expect(checkSlack(undefined, new Date())).toBe('skipped');
  });

  it('returns ok when Socket Mode is connected', () => {
    const client = {
      isStarted: () => true,
      isSocketConnected: () => true,
    };
    expect(checkSlack(client, new Date(0))).toBe('ok');
  });

  it('returns ok within boot grace when started but not yet connected', () => {
    const client = {
      isStarted: () => true,
      isSocketConnected: () => false,
    };
    expect(checkSlack(client, new Date(Date.now() - 5_000), 60_000)).toBe('ok');
  });

  it('returns fail past boot grace when Socket Mode is disconnected', () => {
    const client = {
      isStarted: () => true,
      isSocketConnected: () => false,
    };
    expect(checkSlack(client, new Date(Date.now() - 120_000), 60_000)).toBe('fail');
  });

  it('returns fail when client was never started', () => {
    const client = {
      isStarted: () => false,
      isSocketConnected: () => false,
    };
    expect(checkSlack(client, new Date())).toBe('fail');
  });
});

describe('checkSms (#1567)', () => {
  it('returns skipped when SMS is not configured', () => {
    expect(checkSms(undefined)).toBe('skipped');
  });

  it('returns ok when the Telnyx webhook handler is installed', () => {
    expect(checkSms({ isWebhookInstalled: () => true })).toBe('ok');
  });

  it('returns fail when the webhook handler is missing', () => {
    expect(checkSms({ isWebhookInstalled: () => false })).toBe('fail');
  });
});

describe('checkVoice (#1567)', () => {
  it('returns skipped when voice is not configured', async () => {
    expect(await checkVoice(undefined, stubLogger)).toBe('skipped');
  });

  it('returns ok when listRooms succeeds', async () => {
    const livekit = { listRooms: vi.fn().mockResolvedValue([]) };
    expect(await checkVoice(livekit, stubLogger)).toBe('ok');
  });

  it('returns fail when listRooms throws', async () => {
    const livekit = { listRooms: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) };
    expect(await checkVoice(livekit, stubLogger)).toBe('fail');
  });
});
