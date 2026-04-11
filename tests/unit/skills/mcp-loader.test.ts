// mcp-loader.test.ts — unit tests for the MCP loader.
//
// The loader connects to MCP servers, discovers tools, and registers them.
// We mock mcp-client.ts so tests don't need real MCP server processes.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SkillRegistry } from '../../../src/skills/registry.js';
import { createSilentLogger } from '../../../src/logger.js';

// ---------------------------------------------------------------------------
// Mock the MCP client module — we never want real processes in unit tests.
// ---------------------------------------------------------------------------

// Build a reusable mock session factory so individual tests can control the
// list of tools returned and inspect whether close() was called.
function makeMockSession(tools: Array<{ name: string; description?: string; inputSchema: object }>) {
  const closeFn = vi.fn().mockResolvedValue(undefined);
  return {
    serverId: 'test-server',
    client: {
      listTools: vi.fn().mockResolvedValue({ tools }),
      callTool: vi.fn(),
      getServerVersion: vi.fn().mockReturnValue({ name: 'test-mcp-server', version: '1.0.0' }),
      close: closeFn,
    },
    close: closeFn,
  };
}

// Hoist mocks so vi.mock factory can reference them.
const mockConnectStdio = vi.fn();
const mockConnectSse = vi.fn();

vi.mock('../../../src/skills/mcp-client.js', () => ({
  connectStdio: mockConnectStdio,
  connectSse: mockConnectSse,
}));

// Import the loader AFTER setting up mocks.
const { loadMcpServers } = await import('../../../src/skills/mcp-loader.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const logger = createSilentLogger();

/** Write a skills.yaml file into a temp directory and return that directory. */
function writeSkillsYaml(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-mcp-test-'));
  fs.writeFileSync(path.join(dir, 'skills.yaml'), content, 'utf-8');
  return dir;
}

/** Return a temp directory with no skills.yaml. */
function emptyConfigDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'curia-mcp-test-'));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('loadMcpServers — absent / empty config', () => {
  it('returns empty array when skills.yaml is absent', async () => {
    const registry = new SkillRegistry();
    const sessions = await loadMcpServers(emptyConfigDir(), registry, logger);
    expect(sessions).toHaveLength(0);
    expect(registry.list()).toHaveLength(0);
  });

  it('returns empty array when skills.yaml is empty', async () => {
    const dir = writeSkillsYaml('');
    const registry = new SkillRegistry();
    const sessions = await loadMcpServers(dir, registry, logger);
    expect(sessions).toHaveLength(0);
  });

  it('returns empty array when servers list is empty', async () => {
    const dir = writeSkillsYaml('servers: []');
    const registry = new SkillRegistry();
    const sessions = await loadMcpServers(dir, registry, logger);
    expect(sessions).toHaveLength(0);
  });
});

describe('loadMcpServers — connection failures (warn-not-crash)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips a server that fails to connect and continues to the next', async () => {
    const workingSession = makeMockSession([
      { name: 'tool-a', inputSchema: { type: 'object', properties: {}, required: [] } },
    ]);
    mockConnectStdio
      .mockRejectedValueOnce(new Error('spawn ENOENT'))  // first server fails
      .mockResolvedValueOnce(workingSession);              // second server succeeds

    const dir = writeSkillsYaml(`
servers:
  - name: broken-server
    transport: stdio
    command: /nonexistent
    action_risk: none
  - name: working-server
    transport: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem"]
    action_risk: none
`);
    const registry = new SkillRegistry();
    const sessions = await loadMcpServers(dir, registry, logger);

    // Only the working server's session is returned.
    expect(sessions).toHaveLength(1);
    expect(sessions[0].serverId).toBe('test-server');
    // The working server's tool was registered.
    expect(registry.get('tool-a')).toBeDefined();
  });

  it('skips a server when tools/list fails and closes the session', async () => {
    const session = makeMockSession([]);
    (session.client.listTools as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('tools/list error'));
    mockConnectStdio.mockResolvedValueOnce(session);

    const dir = writeSkillsYaml(`
servers:
  - name: bad-tools-server
    transport: stdio
    command: npx
    action_risk: none
`);
    const registry = new SkillRegistry();
    const sessions = await loadMcpServers(dir, registry, logger);

    expect(sessions).toHaveLength(0);
    // Session must be closed when tools/list fails.
    expect(session.close).toHaveBeenCalledOnce();
  });

  it('skips a stdio server with missing command field', async () => {
    const dir = writeSkillsYaml(`
servers:
  - name: no-command
    transport: stdio
    action_risk: none
`);
    const registry = new SkillRegistry();
    const sessions = await loadMcpServers(dir, registry, logger);
    expect(sessions).toHaveLength(0);
    expect(mockConnectStdio).not.toHaveBeenCalled();
  });

  it('skips an sse server with missing url field', async () => {
    const dir = writeSkillsYaml(`
servers:
  - name: no-url
    transport: sse
    action_risk: none
`);
    const registry = new SkillRegistry();
    const sessions = await loadMcpServers(dir, registry, logger);
    expect(sessions).toHaveLength(0);
    expect(mockConnectSse).not.toHaveBeenCalled();
  });
});

describe('loadMcpServers — tool registration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers tools from a stdio server', async () => {
    const session = makeMockSession([
      {
        name: 'read_file',
        description: 'Read a file from the filesystem',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string', description: 'File path' } },
          required: ['path'],
        },
      },
      {
        name: 'write_file',
        description: 'Write content to a file',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            content: { type: 'string' },
          },
          required: ['path', 'content'],
        },
      },
    ]);
    session.serverId = 'filesystem';
    mockConnectStdio.mockResolvedValueOnce(session);

    const dir = writeSkillsYaml(`
servers:
  - name: filesystem
    transport: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/data"]
    action_risk: low
    sensitivity: normal
    timeout_ms: 15000
`);
    const registry = new SkillRegistry();
    const sessions = await loadMcpServers(dir, registry, logger);

    expect(sessions).toHaveLength(1);

    // Both tools registered.
    const readFile = registry.get('read_file');
    expect(readFile).toBeDefined();
    expect(readFile!.manifest.description).toBe('Read a file from the filesystem');
    expect(readFile!.manifest.action_risk).toBe('low');
    expect(readFile!.manifest.sensitivity).toBe('normal');
    expect(readFile!.manifest.timeout).toBe(15000);
    // mcpInputSchema is stored for the fast-path in toToolDefinitions.
    expect(readFile!.mcpInputSchema).toEqual({
      type: 'object',
      properties: { path: { type: 'string', description: 'File path' } },
      required: ['path'],
    });

    const writeFile = registry.get('write_file');
    expect(writeFile).toBeDefined();
    expect(writeFile!.manifest.action_risk).toBe('low');
  });

  it('applies server-level action_risk and sensitivity to all tools', async () => {
    const session = makeMockSession([
      { name: 'tool-x', inputSchema: { type: 'object', properties: {}, required: [] } },
      { name: 'tool-y', inputSchema: { type: 'object', properties: {}, required: [] } },
    ]);
    mockConnectStdio.mockResolvedValueOnce(session);

    const dir = writeSkillsYaml(`
servers:
  - name: test
    transport: stdio
    command: npx
    action_risk: high
    sensitivity: elevated
`);
    const registry = new SkillRegistry();
    await loadMcpServers(dir, registry, logger);

    expect(registry.get('tool-x')!.manifest.action_risk).toBe('high');
    expect(registry.get('tool-x')!.manifest.sensitivity).toBe('elevated');
    expect(registry.get('tool-y')!.manifest.action_risk).toBe('high');
    expect(registry.get('tool-y')!.manifest.sensitivity).toBe('elevated');
  });

  it('defaults sensitivity to normal when not specified', async () => {
    const session = makeMockSession([
      { name: 'tool-z', inputSchema: { type: 'object', properties: {}, required: [] } },
    ]);
    mockConnectStdio.mockResolvedValueOnce(session);

    const dir = writeSkillsYaml(`
servers:
  - name: test
    transport: stdio
    command: npx
    action_risk: none
`);
    const registry = new SkillRegistry();
    await loadMcpServers(dir, registry, logger);

    expect(registry.get('tool-z')!.manifest.sensitivity).toBe('normal');
  });

  it('defaults timeout to 30000 when not specified', async () => {
    const session = makeMockSession([
      { name: 'tool-t', inputSchema: { type: 'object', properties: {}, required: [] } },
    ]);
    mockConnectStdio.mockResolvedValueOnce(session);

    const dir = writeSkillsYaml(`
servers:
  - name: test
    transport: stdio
    command: npx
    action_risk: none
`);
    const registry = new SkillRegistry();
    await loadMcpServers(dir, registry, logger);

    expect(registry.get('tool-t')!.manifest.timeout).toBe(30000);
  });

  it('uses connectSse for sse transport', async () => {
    const session = makeMockSession([
      { name: 'github_search', inputSchema: { type: 'object', properties: {}, required: [] } },
    ]);
    mockConnectSse.mockResolvedValueOnce(session);

    const dir = writeSkillsYaml(`
servers:
  - name: github
    transport: sse
    url: https://mcp-github.example.com/sse
    action_risk: medium
`);
    const registry = new SkillRegistry();
    await loadMcpServers(dir, registry, logger);

    expect(mockConnectSse).toHaveBeenCalledOnce();
    expect(mockConnectStdio).not.toHaveBeenCalled();
    expect(registry.get('github_search')).toBeDefined();
  });

  it('skips duplicate tool names with a warning (does not crash)', async () => {
    const session = makeMockSession([
      { name: 'duplicate_tool', inputSchema: { type: 'object', properties: {}, required: [] } },
    ]);
    mockConnectStdio.mockResolvedValue(session);

    const dir = writeSkillsYaml(`
servers:
  - name: server-a
    transport: stdio
    command: npx
    action_risk: none
  - name: server-b
    transport: stdio
    command: npx
    action_risk: none
`);
    const registry = new SkillRegistry();
    // Should not throw — duplicate registration is a warning, not a crash.
    await expect(loadMcpServers(dir, registry, logger)).resolves.not.toThrow();
    // The first registration wins.
    expect(registry.get('duplicate_tool')).toBeDefined();
  });
});

describe('loadMcpServers — tools/call round-trip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes tools/call through the registered SkillHandler', async () => {
    const mcpResult = {
      content: [{ type: 'text', text: 'file contents here' }],
      isError: false,
    };
    const session = makeMockSession([
      { name: 'read_file', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
    ]);
    (session.client.callTool as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mcpResult);
    mockConnectStdio.mockResolvedValueOnce(session);

    const dir = writeSkillsYaml(`
servers:
  - name: fs
    transport: stdio
    command: npx
    action_risk: none
`);
    const registry = new SkillRegistry();
    await loadMcpServers(dir, registry, logger);

    const skill = registry.get('read_file')!;
    const result = await skill.handler.execute({
      input: { path: '/tmp/test.txt' },
      secret: () => '',
      log: logger,
    });

    expect(result).toEqual({ success: true, data: 'file contents here' });
    expect(session.client.callTool).toHaveBeenCalledWith({
      name: 'read_file',
      arguments: { path: '/tmp/test.txt' },
    });
  });

  it('returns success: false when MCP tool returns isError: true', async () => {
    const session = makeMockSession([
      { name: 'bad_tool', inputSchema: { type: 'object', properties: {}, required: [] } },
    ]);
    (session.client.callTool as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Permission denied' }],
      isError: true,
    });
    mockConnectStdio.mockResolvedValueOnce(session);

    const dir = writeSkillsYaml(`
servers:
  - name: test
    transport: stdio
    command: npx
    action_risk: none
`);
    const registry = new SkillRegistry();
    await loadMcpServers(dir, registry, logger);

    const result = await registry.get('bad_tool')!.handler.execute({
      input: {},
      secret: () => '',
      log: logger,
    });

    expect(result).toEqual({ success: false, error: 'Permission denied' });
  });

  it('returns success: false when callTool throws (never propagates)', async () => {
    const session = makeMockSession([
      { name: 'erroring_tool', inputSchema: { type: 'object', properties: {}, required: [] } },
    ]);
    (session.client.callTool as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('connection lost'));
    mockConnectStdio.mockResolvedValueOnce(session);

    const dir = writeSkillsYaml(`
servers:
  - name: test
    transport: stdio
    command: npx
    action_risk: none
`);
    const registry = new SkillRegistry();
    await loadMcpServers(dir, registry, logger);

    const result = await registry.get('erroring_tool')!.handler.execute({
      input: {},
      secret: () => '',
      log: logger,
    });

    // Must never throw — returns SkillResult failure instead.
    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/connection lost/);
  });
});
