// channel-registry.test.ts — exercises the channel registry HTTP routes against a fake
// service. Auth is satisfied via the x-web-bootstrap-secret header path of assertSecret
// (same path registry.ts uses); sessions is a real empty Map per session-auth's SessionStore.
import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { channelRegistryRoutes } from './channel-registry.js';
import { ChannelGuardError } from '../../../registry/channel-registry-types.js';
import type { ChannelRegistryService } from '../../../registry/channel-registry-service.js';
import type { ChannelRegistryEntry } from '../../../registry/channel-registry-types.js';

const BOOTSTRAP = 'test-bootstrap-secret';

const sampleEntry: ChannelRegistryEntry = {
  name: 'signal',
  description: '',
  state: 'uninstalled',
  isToggleable: true,
  credentialFields: [],
  requiredResolvable: false,
  installedAt: null,
  installedBy: null,
  enabledAt: null,
  enabledBy: null,
};

// Build a fake ChannelRegistryService. Only the methods the routes call are implemented;
// cast through the interface so the test stays honest about the shape it depends on.
function fakeService(overrides: Partial<ChannelRegistryService> = {}): ChannelRegistryService {
  const base: Partial<ChannelRegistryService> = {
    list: async () => [sampleEntry],
    install: async () => ({ ...sampleEntry, state: 'installed' }),
    enable: async () => ({ ...sampleEntry, state: 'enabled' }),
    disable: async () => ({ ...sampleEntry, state: 'installed' }),
    uninstall: async () => {},
    ...overrides,
  };
  return base as ChannelRegistryService;
}

async function build(service: ChannelRegistryService): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(channelRegistryRoutes, {
    channelRegistryService: service,
    webAppBootstrapSecret: BOOTSTRAP,
    sessions: new Map(),
  });
  return app;
}

const auth = { 'x-web-bootstrap-secret': BOOTSTRAP };

describe('channel registry routes', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  it('GET /api/registry/channels returns the list', async () => {
    app = await build(fakeService());
    const res = await app.inject({ method: 'GET', url: '/api/registry/channels', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().channels[0].name).toBe('signal');
  });

  it('POST install returns the updated entry', async () => {
    app = await build(fakeService());
    const res = await app.inject({
      method: 'POST',
      url: '/api/registry/channels/signal/install',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().entry.state).toBe('installed');
  });

  it('DELETE uninstall returns ok', async () => {
    app = await build(fakeService());
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/registry/channels/signal',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it('POST enable maps ChannelGuardError to 400', async () => {
    app = await build(
      fakeService({
        enable: async () => {
          throw new ChannelGuardError('nope');
        },
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/registry/channels/signal/enable',
      headers: auth,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('nope');
  });

  it('maps unexpected errors to 500', async () => {
    app = await build(
      fakeService({
        install: async () => {
          throw new Error('db exploded');
        },
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/registry/channels/signal/install',
      headers: auth,
    });
    expect(res.statusCode).toBe(500);
  });

  it('rejects unauthenticated requests', async () => {
    app = await build(fakeService());
    const res = await app.inject({ method: 'GET', url: '/api/registry/channels' });
    expect(res.statusCode).toBe(401);
  });
});
