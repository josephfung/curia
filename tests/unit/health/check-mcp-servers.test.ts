import { describe, it, expect, vi } from 'vitest';
import { checkMcpServers, mcpHealthKey } from '../../../src/health/health-checks.js';
import { createSilentLogger } from '../../../src/logger.js';

describe('checkMcpServers (#1500)', () => {
  const logger = createSilentLogger();

  it('fails boot zero_tools without calling listTools', async () => {
    const listTools = vi.fn();
    const result = await checkMcpServers(
      new Map([['google-workspace', { status: 'zero_tools' }]]),
      [{ serverId: 'google-workspace', client: { listTools } }],
      logger,
    );
    expect(result).toEqual({ google_workspace: 'fail' });
    expect(listTools).not.toHaveBeenCalled();
  });

  it('fails boot unavailable without calling listTools', async () => {
    const result = await checkMcpServers(
      new Map([['google-workspace', { status: 'unavailable', reason: 'connect failed' }]]),
      [],
      logger,
    );
    expect(result).toEqual({ google_workspace: 'fail' });
  });

  it('probes live tools/list for boot-ok servers and fails on empty', async () => {
    const listTools = vi.fn().mockResolvedValue({ tools: [] });
    const result = await checkMcpServers(
      new Map([['google-workspace', { status: 'ok', toolCount: 10 }]]),
      [{ serverId: 'google-workspace', client: { listTools } }],
      logger,
    );
    expect(result).toEqual({ google_workspace: 'fail' });
    expect(listTools).toHaveBeenCalled();
  });

  it('returns ok when live tools/list has tools', async () => {
    const listTools = vi.fn().mockResolvedValue({ tools: [{ name: 'drive_search' }] });
    const result = await checkMcpServers(
      new Map([['google-workspace', { status: 'ok', toolCount: 1 }]]),
      [{ serverId: 'google-workspace', client: { listTools } }],
      logger,
    );
    expect(result).toEqual({ google_workspace: 'ok' });
  });

  it('returns empty object when no enabled servers were attempted', async () => {
    const result = await checkMcpServers(new Map(), [], logger);
    expect(result).toEqual({});
  });

  it('returns a result for every enabled server (mixed outcomes)', async () => {
    const result = await checkMcpServers(
      new Map([
        ['alpha', { status: 'zero_tools' }],
        ['beta', { status: 'ok', toolCount: 3 }],
        ['gamma', { status: 'ok', toolCount: 1 }], // boot-ok but no live session → fail
      ]),
      [{ serverId: 'beta', client: { listTools: vi.fn().mockResolvedValue({ tools: [{ name: 't' }] }) } }],
      logger,
    );
    expect(result).toEqual({ alpha: 'fail', beta: 'ok', gamma: 'fail' });
  });

  it('probes servers concurrently, not serially (#1500 review)', async () => {
    // Deferred probes: both must be in flight before either resolves. Serial
    // probing would leave B uncalled until A settles.
    let resolveA!: (value: { tools?: unknown[] }) => void;
    let resolveB!: (value: { tools?: unknown[] }) => void;
    const listToolsA = vi.fn(() => new Promise<{ tools?: unknown[] }>((resolve) => { resolveA = resolve; }));
    const listToolsB = vi.fn(() => new Promise<{ tools?: unknown[] }>((resolve) => { resolveB = resolve; }));

    const promise = checkMcpServers(
      new Map([
        ['server-a', { status: 'ok', toolCount: 1 }],
        ['server-b', { status: 'ok', toolCount: 1 }],
      ]),
      [
        { serverId: 'server-a', client: { listTools: listToolsA } },
        { serverId: 'server-b', client: { listTools: listToolsB } },
      ],
      logger,
    );

    await Promise.resolve(); // flush microtasks; both probes should now be started
    expect(listToolsA).toHaveBeenCalledTimes(1);
    expect(listToolsB).toHaveBeenCalledTimes(1);

    resolveA({ tools: [{ name: 'a' }] });
    resolveB({ tools: [{ name: 'b' }] });
    expect(await promise).toEqual({ server_a: 'ok', server_b: 'ok' });
  });

  it('mcpHealthKey normalizes hyphens to underscores', () => {
    expect(mcpHealthKey('google-workspace')).toBe('google_workspace');
  });
});
