// The Voice check's LiveKit probe (#2357): maps a saved-keys lookup and a room listing to a verdict.
import { describe, it, expect, vi } from 'vitest';
import { probeLiveKit } from '../../../src/setup/livekit-probe.js';
import { createSilentLogger } from '../../../src/logger.js';

const KEYS: Record<string, string> = {
  'channel.voice.livekit_api_key': 'APIkey',
  'channel.voice.livekit_api_secret': 'sekret',
};
const getSecret = async (name: string): Promise<string | null> => KEYS[name] ?? null;
const managementUrl = 'http://livekit:7880';

describe('probeLiveKit', () => {
  it('no_keys when the secret is missing', async () => {
    const listRooms = vi.fn();
    const result = await probeLiveKit({
      getSecret: async (n) => (n.endsWith('_api_secret') ? null : 'APIkey'),
      managementUrl, logger: createSilentLogger(), listRooms,
    });
    expect(result).toBe('no_keys');
    expect(listRooms).not.toHaveBeenCalled();
  });

  it('ok when listRooms resolves', async () => {
    const listRooms = vi.fn().mockResolvedValue([]);
    const result = await probeLiveKit({ getSecret, managementUrl, logger: createSilentLogger(), listRooms });
    expect(result).toBe('ok');
    expect(listRooms).toHaveBeenCalledWith(
      { apiKey: 'APIkey', apiSecret: 'sekret', livekitManagementUrl: 'http://livekit:7880' },
      expect.any(Number),
    );
  });

  it('rejected on 401', async () => {
    const listRooms = vi.fn().mockRejectedValue(Object.assign(new Error('unauthorized'), { status: 401 }));
    expect(await probeLiveKit({ getSecret, managementUrl, logger: createSilentLogger(), listRooms })).toBe('rejected');
  });

  it('rejected on 403', async () => {
    const listRooms = vi.fn().mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    expect(await probeLiveKit({ getSecret, managementUrl, logger: createSilentLogger(), listRooms })).toBe('rejected');
  });

  it('unreachable on a 500, logged at warn', async () => {
    const logger = createSilentLogger();
    const warn = vi.spyOn(logger, 'warn');
    const debug = vi.spyOn(logger, 'debug');
    const listRooms = vi.fn().mockRejectedValue(Object.assign(new Error('internal error'), { status: 500 }));
    expect(await probeLiveKit({ getSecret, managementUrl, logger, listRooms })).toBe('unreachable');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatchObject({ status: 500, managementUrl });
    expect(debug).not.toHaveBeenCalled();
  });

  it('a connection error stays at debug', async () => {
    const logger = createSilentLogger();
    const warn = vi.spyOn(logger, 'warn');
    const debug = vi.spyOn(logger, 'debug');
    const listRooms = vi.fn().mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    expect(await probeLiveKit({ getSecret, managementUrl, logger, listRooms })).toBe('unreachable');
    expect(debug).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('unreachable on a connection error', async () => {
    const listRooms = vi.fn().mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    expect(await probeLiveKit({ getSecret, managementUrl, logger: createSilentLogger(), listRooms })).toBe('unreachable');
  });

  // fetch() wraps the socket error: TypeError('fetch failed') with the code on `cause`.
  const fetchFailed = (code: string): Error =>
    Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });

  it('unreachable (debug) on a refused connection wrapped by fetch', async () => {
    const logger = createSilentLogger();
    const warn = vi.spyOn(logger, 'warn');
    const listRooms = vi.fn().mockRejectedValue(fetchFailed('ECONNREFUSED'));
    expect(await probeLiveKit({ getSecret, managementUrl, logger, listRooms })).toBe('unreachable');
    expect(warn).not.toHaveBeenCalled();
  });

  for (const code of ['ENOTFOUND', 'EAI_AGAIN']) {
    it(`misconfigured (warn) when the management host does not resolve (${code})`, async () => {
      const logger = createSilentLogger();
      const warn = vi.spyOn(logger, 'warn');
      const listRooms = vi.fn().mockRejectedValue(fetchFailed(code));
      expect(await probeLiveKit({ getSecret, managementUrl, logger, listRooms })).toBe('misconfigured');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toMatchObject({ managementUrl });
    });
  }

  it('misconfigured on a bare ENOTFOUND error', async () => {
    const listRooms = vi.fn().mockRejectedValue(Object.assign(new Error('getaddrinfo ENOTFOUND livekit'), { code: 'ENOTFOUND' }));
    expect(await probeLiveKit({ getSecret, managementUrl, logger: createSilentLogger(), listRooms })).toBe('misconfigured');
  });

  it('misconfigured (warn) on a timeout', async () => {
    const logger = createSilentLogger();
    const warn = vi.spyOn(logger, 'warn');
    // AbortSignal.timeout() rejects fetch with a DOMException named TimeoutError.
    const listRooms = vi.fn().mockRejectedValue(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    expect(await probeLiveKit({ getSecret, managementUrl, logger, listRooms })).toBe('misconfigured');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('misconfigured on a connect timeout from undici', async () => {
    const listRooms = vi.fn().mockRejectedValue(fetchFailed('UND_ERR_CONNECT_TIMEOUT'));
    expect(await probeLiveKit({ getSecret, managementUrl, logger: createSilentLogger(), listRooms })).toBe('misconfigured');
  });
});
