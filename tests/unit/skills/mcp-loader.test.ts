// mcp-loader.test.ts — unit tests for the MCP loader.
//
// The loader connects to MCP servers, discovers tools, and registers them.
// We mock mcp-client.ts so tests don't need real MCP server processes.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ToolRegistry } from '../../../src/skills/registry.js';
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
const { loadMcpServers, buildMcpToolHandler } = await import('../../../src/skills/mcp-loader.js');
type BuildHandlerParams = Parameters<typeof buildMcpToolHandler>[0];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const logger = createSilentLogger();

// Vault double. These tests don't exercise vault resolution — none of their
// fixtures use an env: sentinel or an "env:" fixed_input — so an empty vault
// (get() always null) is sufficient. The 4th loadMcpServers arg is required
// as of #913; vault-resolution behavior is unit-tested in src/skills/mcp-loader.test.ts.
const secrets = {
  get: async (): Promise<string | null> => null,
} as unknown as import('../../../src/secrets/secrets-service.js').SecretsService;

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
    const registry = new ToolRegistry();
    const { sessions } = await loadMcpServers(emptyConfigDir(), registry, logger, secrets);
    expect(sessions).toHaveLength(0);
    expect(registry.list()).toHaveLength(0);
  });

  it('returns empty array when skills.yaml is empty', async () => {
    const dir = writeSkillsYaml('');
    const registry = new ToolRegistry();
    const { sessions } = await loadMcpServers(dir, registry, logger, secrets);
    expect(sessions).toHaveLength(0);
  });

  it('returns empty array when servers list is empty', async () => {
    const dir = writeSkillsYaml('servers: []');
    const registry = new ToolRegistry();
    const { sessions } = await loadMcpServers(dir, registry, logger, secrets);
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
    const registry = new ToolRegistry();
    const { sessions } = await loadMcpServers(dir, registry, logger, secrets);

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
    const registry = new ToolRegistry();
    const { sessions } = await loadMcpServers(dir, registry, logger, secrets);

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
    const registry = new ToolRegistry();
    const { sessions } = await loadMcpServers(dir, registry, logger, secrets);
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
    const registry = new ToolRegistry();
    const { sessions } = await loadMcpServers(dir, registry, logger, secrets);
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
    const registry = new ToolRegistry();
    const { sessions } = await loadMcpServers(dir, registry, logger, secrets);

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
    const registry = new ToolRegistry();
    await loadMcpServers(dir, registry, logger, secrets);

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
    const registry = new ToolRegistry();
    await loadMcpServers(dir, registry, logger, secrets);

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
    const registry = new ToolRegistry();
    await loadMcpServers(dir, registry, logger, secrets);

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
    const registry = new ToolRegistry();
    await loadMcpServers(dir, registry, logger, secrets);

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
    const registry = new ToolRegistry();
    // Should not throw — duplicate registration is a warning, not a crash.
    await expect(loadMcpServers(dir, registry, logger, secrets)).resolves.not.toThrow();
    // The first registration wins.
    expect(registry.get('duplicate_tool')).toBeDefined();
  });
});

describe('loadMcpServers — tools/call round-trip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes tools/call through the registered ToolHandler', async () => {
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
    const registry = new ToolRegistry();
    await loadMcpServers(dir, registry, logger, secrets);

    const skill = registry.get('read_file')!;
    const result = await skill.handler.execute({
      toolName: 'read_file',
      toolVersion: '1.0.0',
      input: { path: '/tmp/test.txt' },
      secret: () => '',
      log: logger,
    });

    expect(result).toEqual({ success: true, data: 'file contents here' });
    // callTool is invoked with the default result schema plus RequestOptions that
    // carry the abort signal and the manifest timeout (default 30s here) (#1666).
    expect(session.client.callTool).toHaveBeenCalledWith(
      { name: 'read_file', arguments: { path: '/tmp/test.txt' } },
      undefined,
      expect.objectContaining({ timeout: 30_000, signal: expect.any(AbortSignal) }),
    );
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
    const registry = new ToolRegistry();
    await loadMcpServers(dir, registry, logger, secrets);

    const result = await registry.get('bad_tool')!.handler.execute({
      toolName: 'bad_tool',
      toolVersion: '1.0.0',
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
    const registry = new ToolRegistry();
    await loadMcpServers(dir, registry, logger, secrets);

    const result = await registry.get('erroring_tool')!.handler.execute({
      toolName: 'erroring_tool',
      toolVersion: '1.0.0',
      input: {},
      secret: () => '',
      log: logger,
    });

    // Must never throw — returns ToolResult failure instead.
    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/connection lost/);
  });
});

describe('buildMcpToolHandler — request cancellation (#1666)', () => {
  // Minimal ToolContext — the handler only reads ctx.input.
  const ctx = {
    toolName: 'search',
    toolVersion: '1.0.0',
    input: { q: 'hi' },
    secret: () => '',
    log: logger,
  } as unknown as import('../../../src/skills/types.js').ToolContext;

  /** Build a session whose client.callTool is the supplied spy. Cast through the
   *  handler's own param type so the mock needn't implement the full SDK Client. */
  function sessionWith(callTool: ReturnType<typeof vi.fn>): BuildHandlerParams['session'] {
    return { serverId: 'srv', client: { callTool } } as unknown as BuildHandlerParams['session'];
  }

  /** Read the RequestOptions (3rd arg) the handler passed to callTool. */
  function optionsFrom(callTool: ReturnType<typeof vi.fn>): { signal: AbortSignal; timeout: number } {
    return callTool.mock.calls[0]![2] as { signal: AbortSignal; timeout: number };
  }

  it('passes an abort signal and explicit timeout, and returns the mapped result on success', async () => {
    vi.useFakeTimers();
    try {
      const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'done' }] });
      const handler = buildMcpToolHandler({
        session: sessionWith(callTool),
        toolName: 'search',
        resolvedFixedInputs: {},
        timeoutMs: 30_000,
        logger,
      });

      const result = await handler.execute(ctx);
      expect(result).toEqual({ success: true, data: 'done' });

      const [callParams, resultSchema] = callTool.mock.calls[0]! as [unknown, unknown, unknown];
      expect(callParams).toEqual({ name: 'search', arguments: { q: 'hi' } });
      expect(resultSchema).toBeUndefined(); // default CallToolResultSchema

      const options = optionsFrom(callTool);
      expect(options.timeout).toBe(30_000);
      expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(options.signal.aborted).toBe(false);

      // The abort timer is cleared on success: advancing past the deadline must NOT
      // abort the (already-returned) signal — no stray abort, no leaked timer.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(options.signal.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts the underlying MCP request when the execution-layer timeout elapses', async () => {
    vi.useFakeTimers();
    try {
      // A hung MCP call that only settles when its abort signal fires — models a
      // slow/stuck subprocess the SDK would otherwise leave pending.
      const callTool = vi.fn(
        (_params: unknown, _schema: unknown, options: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(new Error('request aborted')));
          }),
      );
      const handler = buildMcpToolHandler({
        session: sessionWith(callTool),
        toolName: 'search',
        resolvedFixedInputs: {},
        timeoutMs: 30_000,
        logger,
      });

      const pending = handler.execute(ctx);
      await vi.advanceTimersByTimeAsync(30_000); // execution-layer deadline fires

      const result = await pending;
      expect(result.success).toBe(false);
      expect(optionsFrom(callTool).signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('merges fixed inputs so the config value wins over caller input', async () => {
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    const handler = buildMcpToolHandler({
      session: sessionWith(callTool),
      toolName: 'search',
      resolvedFixedInputs: { q: 'FIXED' },
      timeoutMs: 30_000,
      logger,
    });

    await handler.execute({ ...ctx, input: { q: 'caller' } } as unknown as typeof ctx);

    const [callParams] = callTool.mock.calls[0]! as [{ arguments: Record<string, unknown> }];
    expect(callParams.arguments).toEqual({ q: 'FIXED' });
  });

  it('returns a failure result AND logs when callTool rejects (transport/abort failures stay visible)', async () => {
    const callTool = vi.fn().mockRejectedValue(new Error('boom'));
    // Spy logger — a thrown rejection is otherwise invisible to operators, so the
    // handler must log it (unlike the exec layer, which only logs actual throws).
    const warn = vi.fn();
    const spyLogger = { warn, error: vi.fn(), info: vi.fn(), debug: vi.fn(), child: () => spyLogger } as unknown as typeof logger;
    const handler = buildMcpToolHandler({
      session: sessionWith(callTool),
      toolName: 'search',
      resolvedFixedInputs: {},
      timeoutMs: 30_000,
      logger: spyLogger,
    });

    const result = await handler.execute(ctx);
    expect(result).toEqual({ success: false, error: "MCP tool 'search' error: boom" });
    // Logs the error CLASS for diagnosis, never the raw message — a thrown message
    // can carry server-echoed fixed_input secrets (#1666 review).
    expect(warn).toHaveBeenCalledWith(
      { server: 'srv', tool: 'search', errorName: 'Error' },
      'MCP tool call threw',
    );
    // Guard: the raw message must not appear anywhere in the logged metadata.
    const [logMeta] = warn.mock.calls[0]!;
    expect(JSON.stringify(logMeta)).not.toContain('boom');
  });
});
