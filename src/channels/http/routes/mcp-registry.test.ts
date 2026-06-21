// mcp-registry.test.ts — exercises the MCP registry HTTP routes against a fake service.
// Auth is satisfied via the x-web-bootstrap-secret header path of assertSecret (same
// pattern as channel-registry.test.ts); sessions is a real empty Map per SessionStore.
import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mcpRegistryRoutes } from './mcp-registry.js';
import { McpGuardError } from '../../../registry/mcp-registry-types.js';
import type { McpRegistryService } from '../../../registry/mcp-registry-service.js';
import type { McpRegistryEntry } from '../../../registry/mcp-registry-types.js';

const BOOTSTRAP = 'test-bootstrap-secret';

const sampleEntry: McpRegistryEntry = {
  name: 'atproto-mcp',
  state: 'uninstalled',
  secretFields: [],
  requiredResolvable: false,
  installedAt: null,
  installedBy: null,
  enabledAt: null,
  enabledBy: null,
};

// Build a fake McpRegistryService. Only the methods the routes call are implemented;
// cast through the interface so the test stays honest about the shape it depends on.
function fakeService(overrides: Partial<McpRegistryService> = {}): McpRegistryService {
  const base: Partial<McpRegistryService> = {
    list: async () => [sampleEntry],
    install: async () => ({ ...sampleEntry, state: 'installed' }),
    enable: async () => ({ ...sampleEntry, state: 'enabled' }),
    disable: async () => ({ ...sampleEntry, state: 'installed' }),
    uninstall: async () => {},
    declaredSecretKeys: () => [],
    enabledServerNames: async () => new Set(),
    ...overrides,
  };
  return base as McpRegistryService;
}

async function build(service: McpRegistryService): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(mcpRegistryRoutes, {
    mcpRegistryService: service,
    webAppBootstrapSecret: BOOTSTRAP,
    sessions: new Map(),
  });
  return app;
}

const auth = { 'x-web-bootstrap-secret': BOOTSTRAP };

describe('MCP registry routes', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  it('GET /api/registry/mcp returns the list', async () => {
    app = await build(fakeService());
    const res = await app.inject({ method: 'GET', url: '/api/registry/mcp', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().servers[0]!.name).toBe('atproto-mcp');
  });

  it('POST install returns the updated entry', async () => {
    app = await build(fakeService());
    const res = await app.inject({
      method: 'POST',
      url: '/api/registry/mcp/atproto-mcp/install',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().entry.state).toBe('installed');
  });

  it('POST enable returns the updated entry', async () => {
    app = await build(fakeService());
    const res = await app.inject({
      method: 'POST',
      url: '/api/registry/mcp/atproto-mcp/enable',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().entry.state).toBe('enabled');
  });

  it('POST disable returns the updated entry', async () => {
    app = await build(fakeService());
    const res = await app.inject({
      method: 'POST',
      url: '/api/registry/mcp/atproto-mcp/disable',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().entry.state).toBe('installed');
  });

  it('DELETE uninstall returns ok', async () => {
    app = await build(fakeService());
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/registry/mcp/atproto-mcp',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it('POST enable maps McpGuardError to 400', async () => {
    app = await build(
      fakeService({
        enable: async () => {
          throw new McpGuardError('Cannot enable: not installed.');
        },
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/registry/mcp/atproto-mcp/enable',
      headers: auth,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Cannot enable: not installed.');
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
      url: '/api/registry/mcp/atproto-mcp/install',
      headers: auth,
    });
    expect(res.statusCode).toBe(500);
  });

  it('rejects unauthenticated requests with 401', async () => {
    app = await build(fakeService());
    const res = await app.inject({ method: 'GET', url: '/api/registry/mcp' });
    expect(res.statusCode).toBe(401);
  });
});
