import { beforeEach, describe, expect, it, vi } from 'vitest';

const generateVAPIDKeys = vi.fn(() => ({ publicKey: 'generated-pub', privateKey: 'generated-priv' }));
const setVapidDetails = vi.fn();
const sendNotification = vi.fn();

vi.mock('web-push', () => ({
  generateVAPIDKeys: () => generateVAPIDKeys(),
  setVapidDetails: (...args: unknown[]) => setVapidDetails(...args),
  sendNotification: (...args: unknown[]) => sendNotification(...args),
  WebPushError: class WebPushError extends Error {
    statusCode: number;
    body: string;
    headers: Record<string, string>;
    constructor(message: string, statusCode: number, headers: Record<string, string>, body: string) {
      super(message);
      this.statusCode = statusCode;
      this.headers = headers;
      this.body = body;
    }
  },
}));

import { loadVapidSetup, logVapidReadiness } from '../../../../src/channels/web/vapid.js';
import type { Logger } from '../../../../src/logger.js';
import type { SecretsService } from '../../../../src/secrets/secrets-service.js';

const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } as unknown as Logger;

function secrets(initial?: { publicKey: string; privateKey: string }): SecretsService & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  if (initial) store.set('web_push_vapid', initial);
  return {
    store,
    async getJSON<T>(name: string): Promise<T | null> {
      return (store.get(name) as T | undefined) ?? null;
    },
    async setJSON(name: string, value: unknown): Promise<void> {
      store.set(name, value);
    },
  } as unknown as SecretsService & { store: Map<string, unknown> };
}

describe('VAPID setup', () => {
  beforeEach(() => {
    generateVAPIDKeys.mockClear();
    setVapidDetails.mockClear();
    sendNotification.mockReset();
  });

  it('does not generate keys when the origin is not https', async () => {
    const vault = secrets();
    const setup = await loadVapidSetup(vault, 'http://curia.example.com', logger);
    expect(setup.configured).toBe(false);
    expect(generateVAPIDKeys).not.toHaveBeenCalled();
  });

  it('generates keys once and adopts the pair the vault holds after the write', async () => {
    const vault = secrets();
    const first = await loadVapidSetup(vault, 'https://curia.example.com', logger);
    const second = await loadVapidSetup(vault, 'https://curia.example.com', logger);
    expect(generateVAPIDKeys).toHaveBeenCalledTimes(1);
    expect(first.publicKey).toBe('generated-pub');
    expect(second.publicKey).toBe('generated-pub');
    expect(setVapidDetails).toHaveBeenCalledWith('https://curia.example.com', 'generated-pub', 'generated-priv');
  });

  it('logs an error when the origin is set but not https, and info when it is unset', () => {
    const log = { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    logVapidReadiness(log as unknown as Logger, 'http://curia.local', false);
    expect(log.error).toHaveBeenCalled();
    logVapidReadiness(log as unknown as Logger, undefined, false);
    expect(log.info).toHaveBeenCalledWith('web push: not configured (APP_ORIGIN is unset)');
  });

  it('sends with a ten-second timeout, a one-day TTL, and high urgency, and keeps the body', async () => {
    const { WebPushError } = await import('web-push');
    sendNotification.mockRejectedValueOnce(new WebPushError(
      'rejected',
      403,
      { 'retry-after': '2' },
      'BadJwtToken',
      'https://fcm.googleapis.com/fcm/send/abc',
    ));
    const setup = await loadVapidSetup(secrets({ publicKey: 'pub', privateKey: 'priv' }), 'https://curia.example.com', logger);
    await expect(setup.sender.send({
      id: 's',
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
      p256dh: 'p',
      authSecret: 'a',
    }, '{}')).rejects.toMatchObject({ statusCode: 403, body: 'BadJwtToken', retryAfterMs: 2000 });
    expect(sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc' }),
      '{}',
      { TTL: 86400, urgency: 'high', timeout: 10_000 },
    );
  });
});
