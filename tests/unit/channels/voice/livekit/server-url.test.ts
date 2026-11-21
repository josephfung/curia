// resolveLiveKitServerUrl (#2357): which LiveKit address Curia's own end uses (server join,
// RoomService, health and the Setup probe). The compose-network name only resolves inside
// the compose network, so a host-run Curia (pnpm dev / pnpm local) falls back to the
// browser-facing URL.
import { describe, it, expect, vi } from 'vitest';
import { resolveLiveKitServerUrl } from '../../../../../src/channels/voice/livekit/server-url.js';
import { createSilentLogger } from '../../../../../src/logger.js';

const notFound = (): Promise<never> =>
  Promise.reject(Object.assign(new Error('getaddrinfo ENOTFOUND livekit'), { code: 'ENOTFOUND' }));

describe('resolveLiveKitServerUrl', () => {
  it('keeps the management URL when its host resolves, and joins over its ws form', async () => {
    const lookup = vi.fn().mockResolvedValue({ address: '172.18.0.3', family: 4 });
    const result = await resolveLiveKitServerUrl({
      managementUrl: 'http://livekit:7880',
      browserUrl: 'wss://curia.example.com',
      logger: createSilentLogger(),
      inContainer: () => false,
      lookup,
    });
    expect(lookup).toHaveBeenCalledWith('livekit');
    expect(result).toEqual({ managementUrl: 'http://livekit:7880', joinUrl: 'ws://livekit:7880' });
  });

  it('never joins over the browser URL while the management host resolves', async () => {
    const result = await resolveLiveKitServerUrl({
      managementUrl: 'http://livekit:7880',
      browserUrl: 'ws://localhost:7880',
      logger: createSilentLogger(),
      inContainer: () => false,
      lookup: async () => ({ address: '172.18.0.3', family: 4 }),
    });
    expect(result.joinUrl).not.toBe('ws://localhost:7880');
    expect(result.joinUrl).toBe('ws://livekit:7880');
  });

  it('falls back to the browser URL when the management host does not resolve, with a warning', async () => {
    const logger = createSilentLogger();
    const warn = vi.spyOn(logger, 'warn');
    const result = await resolveLiveKitServerUrl({
      managementUrl: 'http://livekit:7880',
      browserUrl: 'ws://localhost:7880',
      logger,
      inContainer: () => false,
      lookup: notFound,
    });
    expect(result).toEqual({ managementUrl: 'http://localhost:7880', joinUrl: 'ws://localhost:7880' });
    expect(warn).toHaveBeenCalledTimes(1);
    const [fields, msg] = warn.mock.calls[0]! as [Record<string, unknown>, string];
    expect(fields).toMatchObject({ managementUrl: 'http://livekit:7880', browserUrl: 'ws://localhost:7880' });
    expect(msg).toContain('channels.voice.livekit_management_url');
  });

  it('maps a wss browser URL to https for management and wss for the join', async () => {
    const result = await resolveLiveKitServerUrl({
      managementUrl: 'http://livekit:7880',
      browserUrl: 'wss://curia.example.com',
      logger: createSilentLogger(),
      inContainer: () => false,
      lookup: notFound,
    });
    expect(result).toEqual({ managementUrl: 'https://curia.example.com', joinUrl: 'wss://curia.example.com' });
  });

  it('treats EAI_AGAIN as not resolving', async () => {
    const result = await resolveLiveKitServerUrl({
      managementUrl: 'http://livekit:7880',
      browserUrl: 'ws://localhost:7880',
      logger: createSilentLogger(),
      inContainer: () => false,
      lookup: () => Promise.reject(Object.assign(new Error('getaddrinfo EAI_AGAIN livekit'), { code: 'EAI_AGAIN' })),
    });
    expect(result.managementUrl).toBe('http://localhost:7880');
  });

  it('keeps the management URL when there is no browser URL to fall back to', async () => {
    const lookup = vi.fn();
    const result = await resolveLiveKitServerUrl({
      managementUrl: 'http://livekit:7880',
      browserUrl: undefined,
      logger: createSilentLogger(),
      inContainer: () => false,
      lookup,
    });
    expect(result).toEqual({ managementUrl: 'http://livekit:7880', joinUrl: 'ws://livekit:7880' });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('strips IPv6 brackets before the lookup', async () => {
    const lookup = vi.fn().mockResolvedValue({ address: '::1', family: 6 });
    await resolveLiveKitServerUrl({
      managementUrl: 'http://[::1]:7880',
      browserUrl: 'ws://localhost:7880',
      logger: createSilentLogger(),
      inContainer: () => false,
      lookup,
    });
    expect(lookup).toHaveBeenCalledWith('::1');
  });

  it('keeps an unparseable management URL and warns', async () => {
    const logger = createSilentLogger();
    const warn = vi.spyOn(logger, 'warn');
    const result = await resolveLiveKitServerUrl({
      managementUrl: 'not a url',
      browserUrl: 'ws://localhost:7880',
      logger,
      inContainer: () => false,
      lookup: vi.fn(),
    });
    expect(result.managementUrl).toBe('not a url');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('in a container, keeps the management URL even when it does not resolve (livekit not up yet)', async () => {
    const lookup = vi.fn(notFound);
    const logger = createSilentLogger();
    const warn = vi.spyOn(logger, 'warn');
    const result = await resolveLiveKitServerUrl({
      managementUrl: 'http://livekit:7880',
      browserUrl: 'ws://localhost:7880',
      logger,
      inContainer: () => true,
      lookup,
    });
    expect(result).toEqual({ managementUrl: 'http://livekit:7880', joinUrl: 'ws://livekit:7880' });
    expect(lookup).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('on the host, a lookup that does not answer in time counts as unresolvable', async () => {
    const result = await resolveLiveKitServerUrl({
      managementUrl: 'http://livekit:7880',
      browserUrl: 'ws://localhost:7880',
      logger: createSilentLogger(),
      inContainer: () => false,
      lookup: () => new Promise(() => {}),
      lookupTimeoutMs: 20,
    });
    expect(result).toEqual({ managementUrl: 'http://localhost:7880', joinUrl: 'ws://localhost:7880' });
  });
});
