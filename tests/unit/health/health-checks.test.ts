import { describe, it, expect, vi } from 'vitest';
import {
  checkDb,
  checkBus,
  checkBrowser,
  checkEmail,
  checkScheduler,
  checkSlack,
  checkSms,
  checkVoice,
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

describe('checkBrowser', () => {
  it('returns skipped when no service provided', () => {
    expect(checkBrowser(undefined)).toBe('skipped');
  });

  it('returns ok when browserContext is a live object', () => {
    // BrowserService uses launchPersistentContext — liveness = context object exists.
    // No .browser() call needed; the context object itself is the liveness signal.
    expect(checkBrowser({ browserContext: {} })).toBe('ok');
  });

  it('returns fail when browserContext is null (service stopped or relaunch failed)', () => {
    expect(checkBrowser({ browserContext: null })).toBe('fail');
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
