import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Logger } from '../../../src/logger.js';

const mockConnect = vi.fn();
const mockGetServerVersion = vi.fn().mockReturnValue({ name: 'mock-server', version: '1.0.0' });
const mockClose = vi.fn().mockResolvedValue(undefined);

const mockClientCtor = vi.fn(function () {
  return {
    connect: mockConnect,
    getServerVersion: mockGetServerVersion,
    close: mockClose,
  };
});

// Captures the options passed to StdioClientTransport so tests can assert on them.
type MockStdioOptions = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  stderr?: 'pipe' | 'ignore' | 'inherit';
};
let lastStdioOptions: MockStdioOptions | undefined;
const stderrEmitter = new EventEmitter();

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: mockClientCtor,
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn(function (options: MockStdioOptions) {
    lastStdioOptions = options;
    return { stderr: stderrEmitter };
  }),
}));

describe('connectStdio', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastStdioOptions = undefined;
    stderrEmitter.removeAllListeners();
    mockConnect.mockResolvedValue(undefined);
  });

  it('logs child stderr output at warn level with server context and trimmed output', async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn(),
    } as unknown as Logger;

    const { connectStdio } = await import('../../../src/skills/mcp-client.js');

    await connectStdio(
      { name: 'workspace-mcp', transport: 'stdio', command: 'node', args: ['server.js'] },
      logger,
    );

    expect(lastStdioOptions.stderr).toBe('pipe');

    stderrEmitter.emit('data', Buffer.from('line one\nline two\n'));

    expect(logger.warn).toHaveBeenCalledWith(
      { server: 'workspace-mcp', stderr: 'line one\nline two' },
      'MCP server stderr',
    );
  });
  it('ignores stderr chunks that only contain trailing whitespace/newlines', async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn(),
    } as unknown as Logger;

    const { connectStdio } = await import('../../../src/skills/mcp-client.js');

    await connectStdio(
      { name: 'workspace-mcp', transport: 'stdio', command: 'node', args: ['server.js'] },
      logger,
    );

    stderrEmitter.emit('data', Buffer.from('\n\n'));

    expect(logger.warn).not.toHaveBeenCalled();
  });

});
