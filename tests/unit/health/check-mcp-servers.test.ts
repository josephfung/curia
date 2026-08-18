import { describe, it, expect, vi } from 'vitest';
import { checkMcpServers, mcpHealthKey, type McpServerBootStatus } from '../../../src/health/health-checks.js';
import { createSilentLogger } from '../../../src/logger.js';

const logger = createSilentLogger();

/**
 * Mock MCP session exposing both `ping` and `listTools` spies, so tests can
 * assert the liveness probe uses `ping()` and never `listTools()` — the latter
 * makes the MCP SDK recompile Ajv validators per call and leaked ~145 MB/hr
 * in prod (#1663).
 */
function makeSession(serverId: string, ping: () => Promise<unknown> = () => Promise.resolve({})) {
  return {
    serverId,
    client: {
      ping: vi.fn(ping),
      listTools: vi.fn(() => Promise.resolve({ tools: [{ name: 't' }] })),
    },
  };
}

describe('checkMcpServers (#1500, #1663)', () => {
  it('pings a boot-ok server, reports ok, and NEVER calls listTools (#1663 leak guard)', async () => {
    const session = makeSession('google-workspace');
    const result = await checkMcpServers(
      new Map<string, McpServerBootStatus>([['google-workspace', { status: 'ok', toolCount: 121 }]]),
      [session],
      logger,
    );
    expect(result).toEqual({ google_workspace: 'ok' });
    expect(session.client.ping).toHaveBeenCalledOnce();
    expect(session.client.listTools).not.toHaveBeenCalled();
  });

  it('fails a boot-ok server when ping rejects (dead/unresponsive subprocess)', async () => {
    const session = makeSession('atproto', () => Promise.reject(new Error('EPIPE')));
    const result = await checkMcpServers(
      new Map<string, McpServerBootStatus>([['atproto', { status: 'ok', toolCount: 8 }]]),
      [session],
      logger,
    );
    expect(result).toEqual({ atproto: 'fail' });
    expect(session.client.ping).toHaveBeenCalledOnce();
  });

  it('fails a hung server via the 3s probe timeout, without listing tools', async () => {
    vi.useFakeTimers();
    try {
      const session = makeSession('google-workspace', () => new Promise<unknown>(() => {}));
      const pending = checkMcpServers(
        new Map<string, McpServerBootStatus>([['google-workspace', { status: 'ok', toolCount: 121 }]]),
        [session],
        logger,
      );
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await pending).toEqual({ google_workspace: 'fail' });
      expect(session.client.listTools).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails boot zero_tools without a live probe', async () => {
    const session = makeSession('google-workspace');
    const result = await checkMcpServers(
      new Map<string, McpServerBootStatus>([['google-workspace', { status: 'zero_tools' }]]),
      [session],
      logger,
    );
    expect(result).toEqual({ google_workspace: 'fail' });
    expect(session.client.ping).not.toHaveBeenCalled();
  });

  it('fails boot unavailable without a live probe', async () => {
    const result = await checkMcpServers(
      new Map<string, McpServerBootStatus>([['google-workspace', { status: 'unavailable', reason: 'connect failed' }]]),
      [],
      logger,
    );
    expect(result).toEqual({ google_workspace: 'fail' });
  });

  it('returns empty object when no enabled servers were attempted', async () => {
    const result = await checkMcpServers(new Map(), [], logger);
    expect(result).toEqual({});
  });

  it('returns a result for every enabled server (mixed outcomes)', async () => {
    const result = await checkMcpServers(
      new Map<string, McpServerBootStatus>([
        ['alpha', { status: 'zero_tools' }],
        ['beta', { status: 'ok', toolCount: 3 }],
        ['gamma', { status: 'ok', toolCount: 1 }], // boot-ok but no live session → fail
      ]),
      [makeSession('beta')],
      logger,
    );
    expect(result).toEqual({ alpha: 'fail', beta: 'ok', gamma: 'fail' });
  });

  it('probes servers concurrently, not serially (#1500 review)', async () => {
    // Deferred probes: both must be in flight before either resolves. Serial
    // probing would leave B uncalled until A settles.
    let resolveA!: (value: unknown) => void;
    let resolveB!: (value: unknown) => void;
    const pingA = vi.fn(() => new Promise<unknown>((resolve) => { resolveA = resolve; }));
    const pingB = vi.fn(() => new Promise<unknown>((resolve) => { resolveB = resolve; }));

    const promise = checkMcpServers(
      new Map<string, McpServerBootStatus>([
        ['server-a', { status: 'ok', toolCount: 1 }],
        ['server-b', { status: 'ok', toolCount: 1 }],
      ]),
      [
        { serverId: 'server-a', client: { ping: pingA } },
        { serverId: 'server-b', client: { ping: pingB } },
      ],
      logger,
    );

    await Promise.resolve(); // flush microtasks; both probes should now be started
    expect(pingA).toHaveBeenCalledTimes(1);
    expect(pingB).toHaveBeenCalledTimes(1);

    resolveA({});
    resolveB({});
    expect(await promise).toEqual({ server_a: 'ok', server_b: 'ok' });
  });

  it('mcpHealthKey normalizes hyphens to underscores', () => {
    expect(mcpHealthKey('google-workspace')).toBe('google_workspace');
  });
});
