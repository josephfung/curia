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

  it('unreachable on a connection error', async () => {
    const listRooms = vi.fn().mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    expect(await probeLiveKit({ getSecret, managementUrl, logger: createSilentLogger(), listRooms })).toBe('unreachable');
  });
});
